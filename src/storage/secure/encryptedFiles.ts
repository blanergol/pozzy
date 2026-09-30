import * as FileSystem from 'expo-file-system/legacy';
import { base64FromBytes, base64ToBytes } from '../../utils/base64';
import { isEnvelope } from './crypto';
import { encryptedCache } from './encryptedCache';
import { keySegment } from './secrets';

/**
 * Файлы ожидающих выгрузки вложений хранятся зашифрованными ключом данных
 * сервера: `pending-attachments/<serverId>/<opId>.enc`. Имя исходного файла
 * есть только в зашифрованной очереди. Перед выгрузкой файл расшифровывается
 * во временный каталог кэша и удаляется сразу после попытки.
 *
 * Файл обрабатывается целиком в памяти JS — для очень больших вложений это
 * заметно по памяти, зато не нужен нативный модуль.
 */

// documentDirectory читаем лениво: в jest нативный модуль недоступен
export function pendingAttachmentsRoot(): string {
  return `${FileSystem.documentDirectory}pending-attachments/`;
}

export function pendingAttachmentsDir(serverId: string): string {
  return `${pendingAttachmentsRoot()}${keySegment(serverId)}/`;
}

function uploadTempDir(): string {
  return `${FileSystem.cacheDirectory}pozzy-upload/`;
}

/** Префикс файлов, которые AttachmentsModal кладёт в кэш для открытия/шаринга. */
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
 * Зашифровать файл в каталог сервера. Запись проверяется обратным чтением;
 * при ошибке зашифрованная копия удаляется, исходник не трогается.
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
  /** Файл, который можно отдать клиенту API. */
  uri: string;
  /** Удалить временную расшифрованную копию (если она создавалась). */
  cleanup: () => Promise<void>;
}

/**
 * Подготовить вложение к выгрузке.
 *   PreparedUpload — можно выгружать;
 *   null — файл безвозвратно нечитаем (его нет, конверт повреждён, ключа данных
 *          нет или проверка подлинности не прошла) — операцию нужно отбросить;
 *   исключение — временный сбой (чтение, нехватка места/памяти): файл и
 *          операцию сохраняем до следующего синка.
 * Legacy-файл открытым текстом отдаётся как есть.
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

/** Удалить файлы ожидающих вложений сервера (каталог и legacy-файлы по списку). */
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
 * Удалить legacy-файлы открытым текстом в корне pending-attachments, на
 * которые больше не ссылается ни одна очередь.
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
 * Удалить временные открытые копии: расшифрованные для выгрузки и скачанные
 * для открытия/шаринга. Вызывается при старте — к этому моменту системный
 * share sheet прошлой сессии давно закрыт.
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
