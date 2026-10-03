import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  PendingOp,
  clearOfflineData,
  legacyOfflineKey,
  loadOfflineData,
  saveOfflineData,
  updateOfflineData,
} from '../../offlineStore';
import {
  loadAISettings,
  loadServers,
  removeServerSecrets,
  saveAISettings,
  saveServers,
} from '../../settings';
import { processAttachmentOps, queueAttachmentUpload } from '../../../data/attachmentQueue';
import { syncNow } from '../../../data/sync';
import { INSTALL_MARKER_KEY, MIGRATION_KEY, runStartupMigration } from '../migration';
import { secretKeys } from '../secrets';
import { rawAsyncStorage, restartApp, secureStoreMock, wipeDevice } from '../../../../test/secureTestUtils';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-file-system/legacy', () => require('../../../../test/mocks/expo-file-system-memory'));

const fs = require('../../../../test/mocks/expo-file-system-memory') as {
  __files: Map<string, Buffer>;
  __reset(): void;
  __failWrites(predicate: ((uri: string) => boolean) | null): void;
};

const P = 'res-prof';
const profile = (password: string) => ({
  id: P,
  baseUrl: 'https://x.example',
  username: 'u',
  password,
  userId: '',
});

function op(opId: string, type: PendingOp['type'], noteId: number, payload: PendingOp['payload'] = {}): PendingOp {
  return { opId, type, noteId, payload, clientTs: '2026-01-05T10:00:00.000Z' };
}

function snapshotDisk(): Record<string, string> {
  return { ...rawAsyncStorage() };
}

async function restoreDisk(snapshot: Record<string, string>): Promise<void> {
  await AsyncStorage.clear();
  await AsyncStorage.multiSet(Object.entries(snapshot));
}

beforeEach(async () => {
  await wipeDevice();
  fs.__reset();
});

describe('секреты: нечитаемое не удаляется', () => {
  it('пароль, который не удалось прочитать, не стирается следующим сохранением профилей', async () => {
    await saveServers({ servers: [profile('S3CRET')], activeId: P });
    restartApp();
    secureStoreMock.__failNext('get', 3);
    const { servers } = await loadServers();
    expect(servers[0].password).toBe('');
    // switching server / editing another profile → persist
    await saveServers({ servers, activeId: P });
    expect(secureStoreMock.__store.get(secretKeys.serverPassword(P))).toBe('S3CRET');
    expect((await loadServers()).servers[0].password).toBe('S3CRET');
  });

  it('API-ключ, который не удалось прочитать, не стирается сохранением других настроек AI', async () => {
    await saveAISettings({ enabled: true, baseUrl: 'https://a', apiKey: 'sk-1', model: 'm' });
    secureStoreMock.__failNext('get', 3);
    const loaded = await loadAISettings();
    expect(loaded.apiKey).toBe('');
    await saveAISettings({ ...loaded, enabled: false });
    expect(secureStoreMock.__store.get(secretKeys.aiApiKey())).toBe('sk-1');
    // the user explicitly clears the key after a successful read — it is deleted
    const again = await loadAISettings();
    await saveAISettings({ ...again, apiKey: '' });
    expect(secureStoreMock.__store.has(secretKeys.aiApiKey())).toBe(false);
  });

  it('запоздавший saveServers не возвращает удалённый профиль и его пароль', async () => {
    const early = saveServers({ servers: [profile('S3CRET')], activeId: P });
    const removal = saveServers({ servers: [], activeId: null });
    const secretsGone = removeServerSecrets(P);
    await Promise.all([early, removal, secretsGone]);
    // one more late write with the old state
    await saveServers({ servers: [profile('S3CRET')], activeId: P });
    expect(secureStoreMock.__store.has(secretKeys.serverPassword(P))).toBe(false);
    expect((await loadServers()).servers).toEqual([]);
  });
});

describe('чистая установка и маркер', () => {
  it('если маркер когда-то не записался, следующий запуск не стирает перенесённые секреты', async () => {
    await AsyncStorage.setItem(
      'poznote.servers.v1',
      JSON.stringify({ servers: [profile('S3CRET')], activeId: P }),
    );
    const setItem = jest.spyOn(AsyncStorage, 'setItem');
    setItem.mockImplementation(async (key: string, value: string) => {
      if (key === INSTALL_MARKER_KEY) throw new Error('disk error');
      await AsyncStorage.multiSet([[key, value]]);
    });
    await runStartupMigration();
    setItem.mockRestore();
    expect(rawAsyncStorage()[INSTALL_MARKER_KEY]).toBeUndefined();
    expect(secureStoreMock.__store.get(secretKeys.serverPassword(P))).toBe('S3CRET');

    restartApp();
    await runStartupMigration();
    expect((await loadServers()).servers[0].password).toBe('S3CRET');
    expect(rawAsyncStorage()[INSTALL_MARKER_KEY]).toBe('1');
  });
});

describe('офлайн-кэш: сбои записи и чтения', () => {
  it('aliases пишутся вместе с очередью: сбой multiSet после записи очереди их не теряет (iOS)', async () => {
    await updateOfflineData(P, (d) => {
      d.pending = [op('c1', 'create', -1, { heading: 'x' }), op('u1', 'update', -1, { content: 'EDIT' })];
    });
    // sync sent the create: alias -1 → 42, the create is removed from the queue
    const multiSet = jest.spyOn(AsyncStorage, 'multiSet').mockImplementationOnce(async (pairs) => {
      // iOS: the first key (the queue) is already on disk, then the process is killed
      rawAsyncStorage()[pairs[0][0]] = pairs[0][1];
      throw new Error('killed');
    });
    await updateOfflineData(P, (d) => {
      d.aliases['-1'] = 42;
      d.pending = d.pending.filter((o) => o.opId !== 'c1');
    });
    multiSet.mockRestore();
    restartApp();
    const data = await loadOfflineData(P);
    expect(data.pending.map((o) => o.opId)).toEqual(['u1']);
    expect(data.aliases).toEqual({ '-1': 42 });
  });

  it('оставшийся после конвертации legacy-блоб не перезаписывает более новые правки', async () => {
    await AsyncStorage.setItem(
      legacyOfflineKey(P),
      JSON.stringify({ pending: [op('old', 'update', 1, { content: 'OLD' })] }),
    );
    await loadOfflineData(P); // conversion, legacy deleted
    await updateOfflineData(P, (d) => {
      d.pending.push(op('new', 'update', 2, { content: 'NEW' }));
    });
    // emulate a failure between the verified write and legacy deletion: the blob is back on disk
    await AsyncStorage.setItem(
      legacyOfflineKey(P),
      JSON.stringify({ pending: [op('old', 'update', 1, { content: 'OLD' })] }),
    );
    restartApp();
    const data = await loadOfflineData(P);
    expect(data.pending.map((o) => o.opId)).toEqual(['old', 'new']);
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toBeUndefined();
  });

  it('ошибка чтения при загрузке: следующее сохранение не затирает сохранённую очередь', async () => {
    await updateOfflineData(P, (d) => {
      d.pending.push(op('stored', 'update', 1, { content: 'STORED' }));
    });
    restartApp();
    const getAllKeys = jest.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('io'));
    const data = await loadOfflineData(P);
    getAllKeys.mockRestore();
    expect(data.pending).toEqual([]);
    data.pending.push(op('fresh', 'update', 2, { content: 'FRESH' }));
    await saveOfflineData(P, data);
    restartApp();
    expect((await loadOfflineData(P)).pending.map((o) => o.opId)).toEqual(['stored', 'fresh']);
  });

  it('падение посреди синка не теряет операции вложений (они остаются в очереди на диске)', async () => {
    fs.__files.set('file:///picker/a.pdf', Buffer.from('ATTACHMENT'));
    await updateOfflineData(P, (d) => {
      d.pending.push(op('u1', 'update', 1, { content: 'A' }), op('u2', 'update', 2, { content: 'B' }));
    });
    await queueAttachmentUpload(P, 1, { uri: 'file:///picker/a.pdf', name: 'a.pdf' });
    let diskDuringSync: Record<string, string> = {};
    const client: any = {
      listNotes: jest.fn(async () => []),
      listFolders: jest.fn(async () => []),
      updateNote: jest.fn(async (id: number) => {
        if (id === 2) diskDuringSync = snapshotDisk(); // "the process is killed" here
      }),
      uploadAttachment: jest.fn(async () => {}),
    };
    await syncNow(client, P);
    await restoreDisk(diskDuringSync);
    restartApp();
    const data = await loadOfflineData(P);
    expect(data.pending.map((o) => o.type)).toEqual(['update', 'attachment']);
  });
});

describe('вложения: временные сбои не удаляют файл', () => {
  it('не удалось записать временную копию → файл и операция сохраняются', async () => {
    fs.__files.set('file:///picker/a.pdf', Buffer.from('ATTACHMENT'));
    const queued = await queueAttachmentUpload(P, 1, { uri: 'file:///picker/a.pdf', name: 'a.pdf' });
    fs.__failWrites((uri) => uri.includes('pozzy-upload'));
    const client: any = { uploadAttachment: jest.fn(async () => {}) };
    const result = await processAttachmentOps(client, P, await loadOfflineData(P));
    fs.__failWrites(null);
    expect(result.pushed).toBe(0);
    expect(client.uploadAttachment).not.toHaveBeenCalled();
    expect(fs.__files.has(queued.payload.localUri as string)).toBe(true);
    expect((await loadOfflineData(P)).pending).toHaveLength(1);
  });

  it('после удаления сервера запоздавшая постановка вложения не воссоздаёт ключ данных', async () => {
    fs.__files.set('file:///picker/a.pdf', Buffer.from('ATTACHMENT'));
    await updateOfflineData(P, () => {});
    await clearOfflineData(P);
    await expect(
      queueAttachmentUpload(P, 1, { uri: 'file:///picker/a.pdf', name: 'a.pdf' }),
    ).rejects.toThrow();
    expect(secureStoreMock.__store.has(secretKeys.serverDataKey(P))).toBe(false);
    expect([...fs.__files.keys()]).toEqual(['file:///picker/a.pdf']);
  });

  it('legacy-вложение без файла не блокирует флаг миграции', async () => {
    await AsyncStorage.setItem(
      legacyOfflineKey(P),
      JSON.stringify({
        pending: [op('a1', 'attachment', 1, { localUri: 'file:///doc/pending-attachments/a1-gone.pdf' })],
      }),
    );
    await runStartupMigration();
    expect(rawAsyncStorage()[MIGRATION_KEY]).toBe('1');
  });
});
