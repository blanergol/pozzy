import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  migrateLegacyAttachmentFiles,
  processAttachmentOps,
  queueAttachmentUpload,
} from '../attachmentQueue';
import { clearOfflineData, legacyOfflineKey, loadOfflineData } from '../../storage/offlineStore';
import { secretKeys } from '../../storage/secure/secrets';
import { cleanupPlaintextTempFiles } from '../../storage/secure/encryptedFiles';
import { runStartupMigration } from '../../storage/secure/migration';
import { rawAsyncStorage, restartApp, secureStoreMock, wipeDevice } from '../../../test/secureTestUtils';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-file-system/legacy', () => require('../../../test/mocks/expo-file-system-memory'));

const fs = require('../../../test/mocks/expo-file-system-memory') as {
  __files: Map<string, Buffer>;
  __reset(): void;
};

const P = 'prof-att';
const SECRET_BYTES = Buffer.from('%PDF-1.7 TOP-SECRET-ATTACHMENT-CONTENT \u0000\u0001ÿ');

function filesText(): string {
  return [...fs.__files.values()].map((b) => b.toString('latin1')).join('\n');
}

function makeClient(upload: (...args: any[]) => Promise<any>): any {
  return { uploadAttachment: jest.fn(upload) };
}

describe('pending attachments (encrypted at rest)', () => {
  beforeEach(async () => {
    await wipeDevice();
    fs.__reset();
    fs.__files.set('file:///picker/report.pdf', Buffer.from(SECRET_BYTES));
  });

  it('файл в очереди хранится только зашифрованным, имя файла — только в очереди', async () => {
    const op = await queueAttachmentUpload(P, 5, {
      uri: 'file:///picker/report.pdf',
      name: 'report.pdf',
      mimeType: 'application/pdf',
    });
    fs.__files.delete('file:///picker/report.pdf'); // кэш пикера очищен системой
    expect(op.payload.localUri).toBe(`file:///doc/pending-attachments/${P}/${op.opId}.enc`);
    expect([...fs.__files.keys()]).toEqual([op.payload.localUri]);
    expect(filesText()).not.toContain('TOP-SECRET');
    expect(JSON.stringify(rawAsyncStorage())).not.toContain('report.pdf');
  });

  it('выгрузка расшифровывает во временный файл и удаляет его после', async () => {
    await queueAttachmentUpload(P, 5, { uri: 'file:///picker/report.pdf', name: 'report.pdf' });
    fs.__files.delete('file:///picker/report.pdf');
    let uploadedBytes: Buffer | undefined;
    const client = makeClient(async (_noteId: number, file: { uri: string; name: string }) => {
      uploadedBytes = fs.__files.get(file.uri);
      expect(file.name).toBe('report.pdf');
      expect(file.uri.startsWith('file:///cache/pozzy-upload/')).toBe(true);
    });
    const data = await loadOfflineData(P);
    const result = await processAttachmentOps(client, P, data);
    expect(result).toEqual({ pushed: 1, networkError: false });
    expect(uploadedBytes?.equals(SECRET_BYTES)).toBe(true);
    expect(fs.__files.size).toBe(0);
    expect((await loadOfflineData(P)).pending).toEqual([]);
  });

  it('сетевая ошибка: временный файл удалён, зашифрованный и операция остаются', async () => {
    const op = await queueAttachmentUpload(P, 5, { uri: 'file:///picker/report.pdf', name: 'r.pdf' });
    fs.__files.delete('file:///picker/report.pdf');
    const client = makeClient(async () => {
      throw new Error('network');
    });
    const result = await processAttachmentOps(client, P, await loadOfflineData(P));
    expect(result.networkError).toBe(true);
    expect([...fs.__files.keys()]).toEqual([op.payload.localUri]);
    expect((await loadOfflineData(P)).pending).toHaveLength(1);
  });

  it('нет ключа данных: операция с нечитаемым файлом отбрасывается без падения', async () => {
    await queueAttachmentUpload(P, 5, { uri: 'file:///picker/report.pdf', name: 'r.pdf' });
    const data = await loadOfflineData(P);
    secureStoreMock.__store.delete(secretKeys.serverDataKey(P));
    restartApp();
    const client = makeClient(async () => {});
    const result = await processAttachmentOps(client, P, data);
    expect(result.pushed).toBe(0);
    expect(client.uploadAttachment).not.toHaveBeenCalled();
    expect(data.pending).toEqual([]);
  });

  it('миграция legacy-файла: шифрование, новый путь в очереди, исходник удалён', async () => {
    fs.__files.delete('file:///picker/report.pdf');
    const legacyUri = 'file:///doc/pending-attachments/op1-report.pdf';
    fs.__files.set(legacyUri, Buffer.from(SECRET_BYTES));
    fs.__files.set('file:///doc/pending-attachments/orphan-old.pdf', Buffer.from('ORPHAN-SECRET'));
    await AsyncStorage.setItem(
      'poznote.servers.v1',
      JSON.stringify({ servers: [{ id: P, baseUrl: 'https://x', username: 'u', password: 'p', userId: '' }], activeId: P }),
    );
    await AsyncStorage.setItem(
      legacyOfflineKey(P),
      JSON.stringify({
        pending: [
          {
            opId: 'op1',
            type: 'attachment',
            noteId: 5,
            payload: { localUri: legacyUri, fileName: 'report.pdf' },
            clientTs: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );

    await runStartupMigration();
    restartApp();
    const op = (await loadOfflineData(P)).pending[0];
    expect(op.payload.localUri).toBe(`file:///doc/pending-attachments/${P}/op1.enc`);
    expect([...fs.__files.keys()]).toEqual([op.payload.localUri]);
    expect(filesText()).not.toContain('SECRET');

    let uploaded: Buffer | undefined;
    const client = makeClient(async (_id: number, file: { uri: string }) => {
      uploaded = fs.__files.get(file.uri);
    });
    await processAttachmentOps(client, P, await loadOfflineData(P));
    expect(uploaded?.equals(SECRET_BYTES)).toBe(true);
  });

  it('повторная миграция после сбоя сохранения не теряет legacy-файл', async () => {
    const legacyUri = 'file:///doc/pending-attachments/op1-report.pdf';
    fs.__files.set(legacyUri, Buffer.from(SECRET_BYTES));
    await AsyncStorage.setItem(
      legacyOfflineKey(P),
      JSON.stringify({
        pending: [
          { opId: 'op1', type: 'attachment', noteId: 5, payload: { localUri: legacyUri, fileName: 'a' }, clientTs: 'x' },
        ],
      }),
    );
    await loadOfflineData(P); // конвертация очереди
    const multiSet = jest.spyOn(AsyncStorage, 'multiSet').mockRejectedValueOnce(new Error('disk full'));
    expect(await migrateLegacyAttachmentFiles(P)).toEqual([legacyUri]);
    multiSet.mockRestore();
    expect(fs.__files.has(legacyUri)).toBe(true);

    restartApp();
    expect(await migrateLegacyAttachmentFiles(P)).toEqual([]);
    expect(fs.__files.has(legacyUri)).toBe(false);
  });

  it('удаление профиля стирает файлы его вложений', async () => {
    await queueAttachmentUpload(P, 5, { uri: 'file:///picker/report.pdf', name: 'r.pdf' });
    fs.__files.delete('file:///picker/report.pdf');
    await clearOfflineData(P);
    expect(fs.__files.size).toBe(0);
  });

  it('при старте удаляются открытые временные копии (шаринг и выгрузка)', async () => {
    fs.__files.set('file:///cache/poznote_5_report.pdf', Buffer.from('x'));
    fs.__files.set('file:///cache/pozzy-upload/op-report.pdf', Buffer.from('x'));
    fs.__files.set('file:///cache/other.bin', Buffer.from('keep'));
    await cleanupPlaintextTempFiles();
    expect([...fs.__files.keys()].sort()).toEqual(['file:///cache/other.bin', 'file:///picker/report.pdf']);
  });
});
