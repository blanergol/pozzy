import * as FileSystem from 'expo-file-system/legacy';
import { PoznoteClient } from '../api/client';
import { UploadFile } from '../api/types';
import {
  OfflineData,
  PendingOp,
  loadOfflineData,
  makeOpId,
  resolveNoteId,
  saveOfflineData,
} from '../storage/offlineStore';

// documentDirectory читаем лениво: в jest нативный модуль недоступен
function pendingDir(): string {
  return `${FileSystem.documentDirectory}pending-attachments/`;
}

function isNetworkError(e: unknown): boolean {
  return e instanceof Error && e.message === 'network';
}

async function deleteLocalFile(uri: string | undefined): Promise<void> {
  if (!uri) return;
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

/**
 * Поставить вложение в оффлайн-очередь: файл копируется во внутренний каталог
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
  const dir = pendingDir();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const localUri = `${dir}${opId}-${safeName}`;
  await FileSystem.copyAsync({ from: file.uri, to: localUri });

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
    if (!localUri) {
      // битая запись без файла — просто вычищаем
      data.pending = data.pending.filter((o) => o.opId !== op.opId);
      continue;
    }
    try {
      await client.uploadAttachment(
        resolveNoteId(data, op.noteId),
        { uri: localUri, name: op.payload.fileName ?? 'attachment', mimeType: op.payload.mimeType },
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
    }
    await deleteLocalFile(localUri);
    data.pending = data.pending.filter((o) => o.opId !== op.opId);
  }
  await saveOfflineData(profileId, data);
  return { pushed, networkError: false };
}
