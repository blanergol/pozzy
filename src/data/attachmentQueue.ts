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
 * Queue an attachment for offline upload: the file is encrypted into the internal directory
 * (the system may purge the DocumentPicker cache), and an 'attachment' op is added to the queue.
 * noteId may be a temporary negative id — it is resolved during sync.
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

/** Attachments of a note pending upload (a temporary id is resolved through aliases). */
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

/** Remove a pending attachment: drop the op from the queue and delete the local file. */
export async function removePendingAttachment(profileId: string, opId: string): Promise<void> {
  const data = await loadOfflineData(profileId);
  const op = data.pending.find((o) => o.opId === opId);
  await deleteLocalFile(op?.payload.localUri);
  data.pending = data.pending.filter((o) => o.opId !== opId);
  await saveOfflineData(profileId, data);
}

/**
 * Upload pending attachments to the server. Called from syncNow AFTER the
 * note operations so that temporary ids have already been resolved to server ids.
 * A network error aborts processing (the queue is kept for the next sync);
 * other errors (4xx) remove the operation and the file to avoid looping forever.
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
        // Transient local failure (read error, disk space): keep the file and the
        // operation and stop processing until the next sync
        await saveOfflineData(profileId, data);
        return { pushed, networkError: false };
      }
    }
    if (!prepared) {
      // broken entry without a file or a permanently unreadable file — clean it up
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
        // connection dropped again — save the queue as is and stop
        await saveOfflineData(profileId, data);
        return { pushed, networkError: true };
      }
      // 4xx and others: remove the operation and the file so they don't block the queue
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
 * Migration: legacy plaintext attachment files (pre-1.1) are encrypted into the
 * server directory. Order: encrypt with verification → write the new path to the
 * queue → only then delete the original. Interruption at any step is safe:
 * the original stays as long as the queue references it.
 * Returns the uris of legacy files the queue still references.
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
    if (!exists) continue; // no file — the upload would have dropped the operation anyway
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
