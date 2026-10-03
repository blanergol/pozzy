import * as FileSystem from 'expo-file-system/legacy';
import { base64FromBytes, base64ToBytes } from '../../utils/base64';
import { isEnvelope } from './crypto';
import { encryptedCache } from './encryptedCache';
import { keySegment } from './secrets';

/**
 * Files of attachments pending upload are stored encrypted with the server's
 * data key: `pending-attachments/<serverId>/<opId>.enc`. The original file name
 * exists only in the encrypted queue. Before upload the file is decrypted
 * into a temporary cache directory and deleted right after the attempt.
 *
 * The file is processed entirely in JS memory — for very large attachments this
 * is noticeable memory-wise, but no native module is needed.
 */

// documentDirectory is read lazily: the native module is unavailable in jest
export function pendingAttachmentsRoot(): string {
  return `${FileSystem.documentDirectory}pending-attachments/`;
}

export function pendingAttachmentsDir(serverId: string): string {
  return `${pendingAttachmentsRoot()}${keySegment(serverId)}/`;
}

function uploadTempDir(): string {
  return `${FileSystem.cacheDirectory}pozzy-upload/`;
}

/** Prefix of files that AttachmentsModal puts in the cache for opening/sharing. */
export const SHARED_ATTACHMENT_PREFIX = 'poznote_';

export function isEncryptedAttachmentUri(uri: string): boolean {
  return uri.endsWith('.enc');
}

function associatedData(serverId: string, opId: string): string {
  return `pozzy.file.${keySegment(serverId)}.${opId}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Encrypt a file into the server's directory. The write is verified by reading it back;
 * on error the encrypted copy is deleted and the original is left untouched.
 */
export async function encryptAttachmentFile(
  serverId: string,
  opId: string,
  sourceUri: string,
): Promise<string> {
  const dir = pendingAttachmentsDir(serverId);
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const destUri = `${dir}${opId}.enc`;
  const ad = associatedData(serverId, opId);
  try {
    const plain = base64ToBytes(
      await FileSystem.readAsStringAsync(sourceUri, { encoding: FileSystem.EncodingType.Base64 }),
    );
    const envelope = await encryptedCache.encryptBytes(serverId, plain, ad);
    await FileSystem.writeAsStringAsync(destUri, envelope, { encoding: FileSystem.EncodingType.UTF8 });
    const back = await FileSystem.readAsStringAsync(destUri, { encoding: FileSystem.EncodingType.UTF8 });
    const check = await encryptedCache.decryptBytes(serverId, back, ad);
    if (!check || !sameBytes(check, plain)) throw new Error('attachment verification failed');
    return destUri;
  } catch (e) {
    await FileSystem.deleteAsync(destUri, { idempotent: true }).catch(() => {});
    throw e;
  }
}

export interface PreparedUpload {
  /** File that can be handed to the API client. */
  uri: string;
  /** Delete the temporary decrypted copy (if one was created). */
  cleanup: () => Promise<void>;
}

/**
 * Prepare an attachment for upload.
 *   PreparedUpload — ready to upload;
 *   null — the file is irrecoverably unreadable (missing, envelope corrupted, no data
 *          key, or authentication failed) — the operation must be dropped;
 *   exception — a transient failure (read error, out of space/memory): the file and
 *          the operation are kept until the next sync.
 * A legacy plaintext file is returned as is.
 */
export async function prepareAttachmentUpload(
  serverId: string,
  opId: string,
  uri: string,
  fileName: string,
): Promise<PreparedUpload | null> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return null;
  if (!isEncryptedAttachmentUri(uri)) return { uri, cleanup: async () => {} };
  const envelope = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
  if (!isEnvelope(envelope)) return null;
  const plain = await encryptedCache.decryptBytes(serverId, envelope, associatedData(serverId, opId));
  if (!plain) return null;
  const dir = uploadTempDir();
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'attachment';
  const tempUri = `${dir}${opId}-${safeName}`;
  try {
    await FileSystem.writeAsStringAsync(tempUri, base64FromBytes(plain), {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (e) {
    await FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
    throw e;
  }
  return {
    uri: tempUri,
    cleanup: () => FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {}),
  };
}

/** Delete the server's pending attachment files (the directory and the listed legacy files). */
export async function deletePendingAttachmentFiles(
  serverId: string,
  legacyUris: readonly string[] = [],
): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  for (const uri of legacyUris) {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
  await FileSystem.deleteAsync(pendingAttachmentsDir(serverId), { idempotent: true }).catch(() => {});
}

/**
 * Delete legacy plaintext files in the pending-attachments root that are
 * no longer referenced by any queue.
 */
export async function sweepLegacyAttachmentFiles(referenced: ReadonlySet<string>): Promise<void> {
  if (!FileSystem.documentDirectory) return;
  const root = pendingAttachmentsRoot();
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const uri = `${root}${name}`;
    const info = await FileSystem.getInfoAsync(uri).catch(() => null);
    if (!info || !info.exists || info.isDirectory) continue;
    if (!referenced.has(uri)) await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
}

/**
 * Delete temporary plaintext copies: those decrypted for upload and those downloaded
 * for opening/sharing. Called at startup — by then the system share sheet of the
 * previous session has long been closed.
 */
export async function cleanupPlaintextTempFiles(): Promise<void> {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) return;
  await FileSystem.deleteAsync(uploadTempDir(), { idempotent: true }).catch(() => {});
  let names: string[] = [];
  try {
    names = await FileSystem.readDirectoryAsync(cacheDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(SHARED_ATTACHMENT_PREFIX)) {
      await FileSystem.deleteAsync(`${cacheDir}${name}`, { idempotent: true }).catch(() => {});
    }
  }
}
