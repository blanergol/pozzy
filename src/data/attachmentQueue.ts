import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { PoznoteClient } from '../api/client';
import { UploadFile } from '../api/types';
import {
  OfflineData,
  PendingOp,
  loadOfflineData,
  makeOpId,
  resolveNoteId,
  saveOfflineData,
  saveOfflineDataStrict,
} from '../storage/offlineStore';
import {
  PreparedUpload,
  encryptAttachmentFile,
  isEncryptedAttachmentUri,
  prepareAttachmentUpload,
} from '../storage/secure/encryptedFiles';

function isNetworkError(e: unknown): boolean {
  return e instanceof Error && e.message === 'network';
}

async function deleteLocalFile(uri: string | undefined): Promise<void> {
  if (!uri) return;
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

/**
 * Поставить вложение в оффлайн-очередь: файл шифруется во внутренний каталог
 * (кэш DocumentPicker система может очистить), в очередь добавляется op 'attachment'.
 * noteId может быть временным отрицательным — разрешится при sync.
 */
export async function queueAttachmentUpload(
  profileId: string,
  noteId: number,
  file: UploadFile,
  workspace?: string,
): Promise<PendingOp> {
  const opId = makeOpId();
  const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'attachment';
  const localUri = await encryptAttachmentFile(profileId, opId, file.uri);

  const op: PendingOp = {
    opId,
    type: 'attachment',
    noteId,
    payload: { localUri, fileName: safeName, mimeType: file.mimeType, workspace },
    clientTs: new Date().toISOString(),
  };
  const data = await loadOfflineData(profileId);
  data.pending.push(op);
  await saveOfflineData(profileId, data);
  return op;
}

/** Ожидающие загрузки вложения заметки (временный id разрешается через aliases). */
export async function listPendingAttachments(
  profileId: string,
  noteId: number,
): Promise<PendingOp[]> {
  const data = await loadOfflineData(profileId);
  const resolved = resolveNoteId(data, noteId);
  return data.pending.filter(
    (op) => op.type === 'attachment' && resolveNoteId(data, op.noteId) === resolved,
  );
}

/** Удалить ожидающее вложение: убрать op из очереди и стереть локальный файл. */
export async function removePendingAttachment(profileId: string, opId: string): Promise<void> {
  const data = await loadOfflineData(profileId);
  const op = data.pending.find((o) => o.opId === opId);
  await deleteLocalFile(op?.payload.localUri);
  data.pending = data.pending.filter((o) => o.opId !== opId);
  await saveOfflineData(profileId, data);
}

/**
 * Выгрузить ожидающие вложения на сервер. Вызывается из syncNow ПОСЛЕ
 * note-операций, чтобы временные id уже разрешились в серверные.
 * Network-ошибка прерывает обработку (очередь остаётся на следующий sync);
 * прочие ошибки (4xx) удаляют операцию и файл, чтобы не зациклиться.
 */
export async function processAttachmentOps(
  client: PoznoteClient,
  profileId: string,
  data: OfflineData,
): Promise<{ pushed: number; networkError: boolean }> {
  const ops = data.pending.filter((op) => op.type === 'attachment');
  let pushed = 0;
  for (const op of ops) {
    const localUri = op.payload.localUri;
    const fileName = op.payload.fileName ?? 'attachment';
    let prepared: PreparedUpload | null = null;
    if (localUri) {
      try {
        prepared = await prepareAttachmentUpload(profileId, op.opId, localUri, fileName);
      } catch {
        // Временный локальный сбой (чтение, место на диске): файл и операцию
        // сохраняем и прекращаем обработку до следующего синка
        await saveOfflineData(profileId, data);
        return { pushed, networkError: false };
      }
    }
    if (!prepared) {
      // битая запись без файла или безвозвратно нечитаемый файл — вычищаем
      await deleteLocalFile(localUri);
      data.pending = data.pending.filter((o) => o.opId !== op.opId);
      continue;
    }
    try {
      await client.uploadAttachment(
        resolveNoteId(data, op.noteId),
        { uri: prepared.uri, name: fileName, mimeType: op.payload.mimeType },
        op.payload.workspace,
      );
      pushed++;
    } catch (e) {
      if (isNetworkError(e)) {
        // связь снова пропала — сохраняем очередь как есть и останавливаемся
        await saveOfflineData(profileId, data);
        return { pushed, networkError: true };
      }
      // 4xx и прочие: убираем операцию и файл, чтобы не блокировать очередь
    } finally {
      await prepared.cleanup();
    }
    await deleteLocalFile(localUri);
    data.pending = data.pending.filter((o) => o.opId !== op.opId);
  }
  await saveOfflineData(profileId, data);
  return { pushed, networkError: false };
}

/**
 * Миграция: legacy-файлы вложений открытым текстом (до 1.1) шифруются в
 * каталог сервера. Порядок: зашифровать с проверкой → записать новый путь в
 * очередь → только потом удалить исходник. Прерывание на любом шаге
 * безопасно: исходник остаётся, пока очередь на него ссылается.
 * Возвращает uri legacy-файлов, на которые очередь всё ещё ссылается.
 */
export async function migrateLegacyAttachmentFiles(profileId: string): Promise<string[]> {
  if (Platform.OS === 'web') return [];
  const data = await loadOfflineData(profileId);
  const stillReferenced: string[] = [];
  for (const op of data.pending) {
    const legacyUri = op.payload.localUri;
    if (op.type !== 'attachment' || !legacyUri || isEncryptedAttachmentUri(legacyUri)) continue;
    const exists = await FileSystem.getInfoAsync(legacyUri)
      .then((info) => info.exists)
      .catch(() => false);
    if (!exists) continue; // файла нет — выгрузка и раньше отбросила бы операцию
    try {
      op.payload.localUri = await encryptAttachmentFile(profileId, op.opId, legacyUri);
      await saveOfflineDataStrict(profileId, data);
      await deleteLocalFile(legacyUri);
    } catch {
      op.payload.localUri = legacyUri;
      stillReferenced.push(legacyUri);
    }
  }
  return stillReferenced;
}
