import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  CachedNote,
  OfflineData,
  PendingOp,
  clearOfflineData,
  legacyOfflineKey,
  loadOfflineData,
  saveOfflineData,
  updateOfflineData,
} from '../offlineStore';
import { secretKeys } from '../secure/secrets';
import { takeLostEdits } from '../secure/lostData';
import { rawAsyncStorage, restartApp, secureStoreMock, wipeDevice } from '../../../test/secureTestUtils';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const P = 'prof-1';

function note(id: number, content: string): CachedNote {
  return {
    id,
    heading: `Note ${id}`,
    type: 'note',
    tags: null,
    folder: null,
    folder_id: null,
    workspace: null,
    updated: '2026-01-01 10:00:00',
    created: '2026-01-01 10:00:00',
    favorite: 0,
    icon: null,
    icon_color: null,
    color: null,
    color_hex: null,
    linked_note_id: null,
    reminder_at: null,
    content,
  } as CachedNote;
}

function updateOp(noteId: number, content: string, opId = `op-${noteId}`): PendingOp {
  return { opId, type: 'update', noteId, payload: { content }, clientTs: '2026-01-05T10:00:00.000Z' };
}

function diskText(): string {
  return JSON.stringify(rawAsyncStorage());
}

describe('offlineStore (encrypted)', () => {
  beforeEach(async () => {
    await wipeDevice();
  });

  it('содержимое заметок и очереди на диске зашифровано и переживает перезапуск', async () => {
    await updateOfflineData(P, (d) => {
      d.notesDetails['1'] = note(1, 'NOTE-CONTENT-1');
      d.pending.push(updateOp(1, 'UNSYNCED-EDIT'));
    });
    expect(diskText()).not.toContain('NOTE-CONTENT');
    expect(diskText()).not.toContain('UNSYNCED-EDIT');
    expect(Object.keys(rawAsyncStorage()).sort()).toEqual([
      `pozzy.cache.${P}.meta`,
      `pozzy.cache.${P}.note.1`,
      `pozzy.cache.${P}.queue`,
    ]);

    restartApp();
    const data = await loadOfflineData(P);
    expect(data.notesDetails['1'].content).toBe('NOTE-CONTENT-1');
    expect(data.pending[0].payload.content).toBe('UNSYNCED-EDIT');
  });

  it('правка одной заметки перешифровывает только её, очередь пишется первой', async () => {
    await updateOfflineData(P, (d) => {
      for (let i = 1; i <= 20; i++) d.notesDetails[String(i)] = note(i, `c${i}`);
    });
    const multiSet = jest.spyOn(AsyncStorage, 'multiSet');
    await updateOfflineData(P, (d) => {
      d.notesDetails['7'].content = 'changed';
      d.pending.push(updateOp(7, 'changed'));
    });
    const keys = (multiSet.mock.calls[0][0] as [string, string][]).map(([k]) => k);
    // meta (list, folders) didn't change — it isn't re-encrypted
    expect(keys).toEqual([`pozzy.cache.${P}.queue`, `pozzy.cache.${P}.note.7`]);

    multiSet.mockClear();
    await updateOfflineData(P, () => {});
    expect(multiSet).not.toHaveBeenCalled();
    multiSet.mockRestore();
  });

  it('удалённые заметки и опустевшая очередь удаляются с диска', async () => {
    await updateOfflineData(P, (d) => {
      d.notesDetails['1'] = note(1, 'a');
      d.notesDetails['2'] = note(2, 'b');
      d.pending.push(updateOp(1, 'x'));
    });
    await updateOfflineData(P, (d) => {
      delete d.notesDetails['2'];
      d.pending = [];
    });
    expect(Object.keys(rawAsyncStorage()).sort()).toEqual([
      `pozzy.cache.${P}.meta`,
      `pozzy.cache.${P}.note.1`,
    ]);
  });

  it('потерян ключ данных: кэш стирается, без падения, сообщение о потерянных правках', async () => {
    await updateOfflineData(P, (d) => {
      d.notesDetails['1'] = note(1, 'a');
      d.pending.push(updateOp(1, 'UNSYNCED-EDIT'));
    });
    secureStoreMock.__store.delete(secretKeys.serverDataKey(P));
    restartApp();

    const data = await loadOfflineData(P);
    expect(data.pending).toEqual([]);
    expect(data.notesDetails).toEqual({});
    expect(Object.keys(rawAsyncStorage()).filter((k) => k.startsWith('pozzy.cache.'))).toEqual([]);
    expect(await takeLostEdits()).toEqual([P]);
    expect(await takeLostEdits()).toEqual([]);

    // the cache works again with the new key
    await updateOfflineData(P, (d) => {
      d.notesDetails['5'] = note(5, 'fresh');
    });
    restartApp();
    expect((await loadOfflineData(P)).notesDetails['5'].content).toBe('fresh');
  });

  it('потерян ключ при пустой очереди: сообщение не показывается', async () => {
    await updateOfflineData(P, (d) => {
      d.notesDetails['1'] = note(1, 'a');
    });
    secureStoreMock.__store.delete(secretKeys.serverDataKey(P));
    restartApp();
    expect((await loadOfflineData(P)).notesDetails).toEqual({});
    expect(await takeLostEdits()).toEqual([]);
  });

  it('повреждена одна заметка: читаемая очередь сохраняется', async () => {
    await updateOfflineData(P, (d) => {
      d.notesDetails['1'] = note(1, 'a');
      d.pending.push(updateOp(1, 'keep me'));
    });
    rawAsyncStorage()[`pozzy.cache.${P}.note.1`] = 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    restartApp();
    const data = await loadOfflineData(P);
    expect(data.pending.map((op) => op.payload.content)).toEqual(['keep me']);
    expect(await takeLostEdits()).toEqual([]);
  });

  it('legacy-блоб конвертируется при чтении и удаляется', async () => {
    const legacy: OfflineData = {
      notesList: [],
      notesDetails: { '1': note(1, 'LEGACY-NOTE') },
      folders: [],
      pending: [updateOp(1, 'LEGACY-EDIT')],
      aliases: { '-1': 1 },
    };
    await AsyncStorage.setItem(legacyOfflineKey(P), JSON.stringify(legacy));
    const data = await loadOfflineData(P);
    expect(data.pending[0].payload.content).toBe('LEGACY-EDIT');
    expect(data.aliases).toEqual({ '-1': 1 });
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toBeUndefined();
    expect(diskText()).not.toContain('LEGACY');
  });

  it('SecureStore недоступен: legacy-блоб не удаляется, данные доступны из памяти', async () => {
    const legacy = { notesDetails: { '1': note(1, 'L') }, pending: [updateOp(1, 'LEGACY-EDIT')] };
    await AsyncStorage.setItem(legacyOfflineKey(P), JSON.stringify(legacy));
    secureStoreMock.__failNext('set', 1000);
    const data = await loadOfflineData(P);
    expect(data.pending[0].payload.content).toBe('LEGACY-EDIT');
    await saveOfflineData(P, data);
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toBeDefined();

    // SecureStore works again — the next write is a full one, legacy is removed
    secureStoreMock.__failNext('set', 0);
    data.pending.push(updateOp(2, 'NEW-EDIT', 'op-new'));
    await saveOfflineData(P, data);
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toBeUndefined();
    restartApp();
    expect((await loadOfflineData(P)).pending.map((op) => op.opId)).toEqual(['op-1', 'op-new']);
  });

  it('clearOfflineData удаляет кэш, ключ данных и не даёт запоздавшей записи его воссоздать', async () => {
    const data = await updateOfflineData(P, (d) => {
      d.notesDetails['1'] = note(1, 'a');
    });
    await clearOfflineData(P);
    await saveOfflineData(P, data); // a late sync
    expect(Object.keys(rawAsyncStorage())).toEqual([]);
    expect(secureStoreMock.__store.has(secretKeys.serverDataKey(P))).toBe(false);
  });
});
