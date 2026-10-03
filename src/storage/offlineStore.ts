import AsyncStorage from '@react-native-async-storage/async-storage';
import { Folder, NoteDetails, NoteListItem } from '../api/types';
import { encryptedCache, serverCachePrefix } from './secure/encryptedCache';
import { deletePendingAttachmentFiles } from './secure/encryptedFiles';
import { recordLostEdits } from './secure/lostData';

/** Note in the local cache; localUpdatedAt is the time of the last LOCAL edit (ISO). */
export interface CachedNote extends NoteDetails {
  localUpdatedAt?: string;
}

/** Operation waiting to be synced with the server. */
export interface PendingOp {
  opId: string;
  type: 'create' | 'update' | 'delete' | 'favorite' | 'attachment';
  /** Note id; for notes created offline it is a temporary negative one. */
  noteId: number;
  payload: {
    heading?: string;
    content?: string;
    tags?: string;
    workspace?: string;
    folder_id?: number | null;
    /** Target favorite state (for type='favorite'). */
    favorite?: number;
    /** Deferred attachment upload (type='attachment'): local copy of the file. */
    localUri?: string;
    fileName?: string;
    mimeType?: string;
  };
  /** ISO time of the local change — the basis for last-write-wins. */
  clientTs: string;
}

export interface OfflineData {
  /** Snapshot of the notes list (server + local edits applied on top). */
  notesList: NoteListItem[];
  /** Full notes by id (string). */
  notesDetails: Record<string, CachedNote>;
  folders: Folder[];
  /** Queue of unsynced operations. */
  pending: PendingOp[];
  /** Remapping of temporary ids → server ids after a create has been synced. */
  aliases: Record<string, number>;
}

function emptyData(): OfflineData {
  // Fresh arrays/objects every time: otherwise profiles would share a common EMPTY.notesList
  return { notesList: [], notesDetails: {}, folders: [], pending: [], aliases: {} };
}

/*
 * Storage layout (all values are encrypted with the server data key):
 *   pozzy.cache.<id>.queue        — queue + aliases (only while the queue is non-empty).
 *                                   aliases live in the same entry as the queue:
 *                                   writing a single key is atomic on all platforms,
 *                                   while multiSet on iOS is not (a failure between "create
 *                                   sent" and "alias written" would otherwise lose edits)
 *   pozzy.cache.<id>.meta         — notes list, folders, aliases, conversion marker
 *   pozzy.cache.<id>.note.<noteId> — full note
 * On save only the changed entries are written, in a single multiSet
 * (one transaction on Android), the queue first.
 *
 * Legacy (pre-1.1): a single plaintext JSON `poznote.offline.<id>.v1`. It is
 * converted on first read; until the new format has been written and verified,
 * the legacy blob remains the source of truth and is not deleted.
 */

export function legacyOfflineKey(profileId: string): string {
  return `poznote.offline.${profileId}.v1`;
}

const queueKey = (profileId: string) => `${serverCachePrefix(profileId)}queue`;
const metaKey = (profileId: string) => `${serverCachePrefix(profileId)}meta`;
const notePrefix = (profileId: string) => `${serverCachePrefix(profileId)}note.`;

interface ProfileState {
  data: OfflineData;
  /** Storage key → the JSON written last (baseline for change tracking). */
  written: Map<string, string>;
  /** The legacy blob has not been deleted yet: the next write must be a full one. */
  legacyPending: boolean;
  /** Web: opIds of operations from the legacy blob that are not yet synced. */
  webLegacyOps?: Set<string>;
  /** Storage could not be read: no writes until we re-read it (otherwise we'd clobber the queue). */
  readFailed?: boolean;
}

// Marker for "entry exists, content unknown" — guarantees an overwrite/delete
const UNKNOWN = '\u0000';

// In-memory cache over the storage: reads/writes are serialized so that
// concurrent edits (autosave + sync) don't lose data.
const cache = new Map<string, ProfileState>();
const loading = new Map<string, Promise<ProfileState>>();
const writeChains = new Map<string, Promise<void>>();
// Removed profiles: a late sync must not recreate their cache and data key
const clearedProfiles = new Set<string>();

function normalize(parsed: Partial<OfflineData>): OfflineData {
  return {
    notesList: Array.isArray(parsed.notesList) ? parsed.notesList : [],
    notesDetails:
      parsed.notesDetails && typeof parsed.notesDetails === 'object' ? parsed.notesDetails : {},
    folders: Array.isArray(parsed.folders) ? parsed.folders : [],
    pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    aliases: parsed.aliases && typeof parsed.aliases === 'object' ? parsed.aliases : {},
  };
}

function queueJson(data: OfflineData): string {
  return JSON.stringify({ pending: data.pending, aliases: data.aliases });
}

function serializeEntries(profileId: string, data: OfflineData): Map<string, string> {
  const entries = new Map<string, string>();
  // insertion order = write order: the queue first
  if (data.pending.length > 0) entries.set(queueKey(profileId), queueJson(data));
  for (const [id, note] of Object.entries(data.notesDetails)) {
    entries.set(notePrefix(profileId) + id, JSON.stringify(note));
  }
  entries.set(
    metaKey(profileId),
    // converted: the new-format entry was written after a verified queue transfer —
    // a leftover legacy blob is stale and must not overwrite it
    JSON.stringify({ notesList: data.notesList, folders: data.folders, aliases: data.aliases, converted: true }),
  );
  return entries;
}

/** Merge data read from storage into the in-memory data (mutates mem). */
function mergeStored(mem: OfflineData, stored: OfflineData): void {
  const memOps = new Set(mem.pending.map((op) => op.opId));
  mem.pending = [...stored.pending.filter((op) => !memOps.has(op.opId)), ...mem.pending];
  mem.notesDetails = { ...stored.notesDetails, ...mem.notesDetails };
  mem.aliases = { ...stored.aliases, ...mem.aliases };
  if (mem.notesList.length === 0) mem.notesList = stored.notesList;
  if (mem.folders.length === 0) mem.folders = stored.folders;
}

/** Write the changed entries. Failure throws; written is updated only on success. */
async function persist(profileId: string, state: ProfileState): Promise<void> {
  if (clearedProfiles.has(profileId)) return;
  if (state.readFailed) {
    // Storage could not be read on load. We must not write over it — that would clobber
    // the saved queue; re-read it first and merge with the in-memory edits.
    const fresh = await readProfile(profileId);
    mergeStored(state.data, fresh.data);
    state.written = fresh.written;
    state.legacyPending = fresh.legacyPending;
    state.webLegacyOps = fresh.webLegacyOps;
    state.readFailed = false;
  }
  if (state.webLegacyOps) await drainWebLegacy(profileId, state);
  const entries = serializeEntries(profileId, state.data);
  const changed: [string, string][] = [];
  for (const [key, json] of entries) {
    if (state.written.get(key) !== json) changed.push([key, json]);
  }
  const removed = [...state.written.keys()].filter((key) => !entries.has(key));
  const qKey = queueKey(profileId);
  // An emptied queue is first overwritten with "[]" in the same transaction as
  // the rest (aliases etc.), and only then deleted: otherwise a failure between
  // the write and the delete would resurrect already-sent operations (duplicate creates).
  if (removed.includes(qKey)) changed.unshift([qKey, queueJson(state.data)]);
  if (changed.length > 0) {
    await encryptedCache.setMany(profileId, changed);
    for (const [key, json] of changed) state.written.set(key, json);
  }
  if (removed.length > 0) {
    await encryptedCache.deleteMany(profileId, removed);
    for (const key of removed) state.written.delete(key);
  }
  if (state.legacyPending && !state.webLegacyOps) {
    // The legacy blob is deleted only after a read-back verification
    const { values } = await encryptedCache.getMany(profileId, [...entries.keys()]);
    for (const [key, json] of entries) {
      if (values.get(key) !== json) throw new Error('verification failed');
    }
    await AsyncStorage.removeItem(legacyOfflineKey(profileId));
    state.legacyPending = false;
  }
}

/**
 * Web: the cache lives in memory, so unsynced edits from the previous version
 * can't be removed from localStorage right away — a page reload would lose them.
 * The legacy key keeps only the legacy operations not yet sent, and is removed
 * as soon as they reach the server.
 */
async function drainWebLegacy(profileId: string, state: ProfileState): Promise<void> {
  const legacyOps = state.webLegacyOps as Set<string>;
  const remaining = state.data.pending.filter((op) => legacyOps.has(op.opId));
  if (remaining.length === 0) {
    await AsyncStorage.removeItem(legacyOfflineKey(profileId));
    state.webLegacyOps = undefined;
    state.legacyPending = false;
    return;
  }
  const referenced = new Set(remaining.map((op) => String(op.noteId)));
  const aliases = Object.fromEntries(
    Object.entries(state.data.aliases).filter(([id]) => referenced.has(id)),
  );
  await AsyncStorage.setItem(
    legacyOfflineKey(profileId),
    JSON.stringify({ pending: remaining, aliases }),
  );
}

async function readLegacy(profileId: string): Promise<OfflineData | null | 'corrupt'> {
  const raw = await AsyncStorage.getItem(legacyOfflineKey(profileId));
  if (raw === null) return null;
  try {
    return normalize(JSON.parse(raw) as Partial<OfflineData>);
  } catch {
    return 'corrupt';
  }
}

/** All new-format entries of the server, marked as "unknown". */
async function existingEntries(profileId: string): Promise<Map<string, string>> {
  const keys = await encryptedCache.keysWithPrefix(serverCachePrefix(profileId));
  return new Map(keys.map((key) => [key, UNKNOWN]));
}

/** Legacy blob conversion: the queue first and verified, then the rest. */
async function convertLegacy(profileId: string, data: OfflineData): Promise<ProfileState> {
  const state: ProfileState = { data, written: new Map(), legacyPending: true };
  if (!encryptedCache.persistent) {
    // web: move into session memory; legacy edits are drained as they sync
    state.webLegacyOps = new Set(data.pending.map((op) => op.opId));
    await persist(profileId, state).catch(() => {});
    return state;
  }
  try {
    state.written = await existingEntries(profileId);
    const entries = serializeEntries(profileId, data);
    const qKey = queueKey(profileId);
    const queue = entries.get(qKey);
    if (queue !== undefined) {
      if (!(await encryptedCache.setVerified(profileId, qKey, queue))) {
        throw new Error('queue verification failed');
      }
      state.written.set(qKey, queue);
    }
    // The rest: write → read-back verification → legacy removal (in persist)
    await persist(profileId, state);
  } catch {
    // Encrypted storage is unavailable: work with the legacy data in memory;
    // the legacy blob stays on disk until the first successful full write.
    state.legacyPending = true;
    state.written = await existingEntries(profileId).catch(() => new Map());
  }
  return state;
}

/** Whether there is a readable new-format meta written after conversion. */
async function isConverted(profileId: string): Promise<boolean> {
  if (!encryptedCache.persistent) return false;
  const { values } = await encryptedCache.getMany(profileId, [metaKey(profileId)]);
  const json = values.get(metaKey(profileId));
  if (!json) return false;
  try {
    return (JSON.parse(json) as { converted?: unknown }).converted === true;
  } catch {
    return false;
  }
}

async function readProfile(profileId: string): Promise<ProfileState> {
  try {
    const legacy = await readLegacy(profileId);
    if (legacy === 'corrupt') {
      // unreadable legacy JSON was replaced with empty data before too
      await AsyncStorage.removeItem(legacyOfflineKey(profileId)).catch(() => {});
    } else if (legacy) {
      if (!(await isConverted(profileId))) return await convertLegacy(profileId, legacy);
      // Failure between the verified new-format write and the legacy removal:
      // the new format is more current (it may contain edits made after conversion)
      if (encryptedCache.persistent) await AsyncStorage.removeItem(legacyOfflineKey(profileId));
    }
  } catch {
    // AsyncStorage is unavailable — try the new format
  }

  const keys = await encryptedCache.keysWithPrefix(serverCachePrefix(profileId));
  const { values, unreadable } = await encryptedCache.getMany(profileId, keys);
  const data = emptyData();
  const written = new Map<string, string>();
  let queueLost = unreadable.includes(queueKey(profileId));
  let queueAliases: Record<string, number> = {};
  let metaAliases: Record<string, number> = {};

  for (const [key, json] of values) {
    try {
      if (key === queueKey(profileId)) {
        const queue = normalize(JSON.parse(json) as Partial<OfflineData>);
        data.pending = queue.pending;
        queueAliases = queue.aliases;
      } else if (key === metaKey(profileId)) {
        const meta = normalize(JSON.parse(json) as Partial<OfflineData>);
        data.notesList = meta.notesList;
        data.folders = meta.folders;
        metaAliases = meta.aliases;
      } else if (key.startsWith(notePrefix(profileId))) {
        data.notesDetails[key.slice(notePrefix(profileId).length)] = JSON.parse(json) as CachedNote;
      }
      written.set(key, json);
    } catch {
      if (key === queueKey(profileId)) queueLost = true;
      written.set(key, UNKNOWN);
    }
  }

  // aliases from the queue entry are newer than or equal to those in meta
  data.aliases = { ...metaAliases, ...queueAliases };

  if (queueLost) await recordLostEdits(profileId).catch(() => {});
  if (unreadable.length > 0) {
    // The data key is lost (restore from backup, another device) or the entries
    // are corrupted: treat the cache as lost and reload it from the server.
    // A readable queue (and the aliases for its temporary ids) is kept — the
    // operations are self-contained and will reach the server on sync.
    const qKey = queueKey(profileId);
    const keepQueue = !queueLost && data.pending.length > 0;
    const rest = [...written.keys()].filter((key) => !(keepQueue && key === qKey));
    await encryptedCache.deleteMany(profileId, rest).catch(() => {});
    const fresh = emptyData();
    const freshWritten = new Map<string, string>();
    if (keepQueue) {
      fresh.pending = data.pending;
      fresh.aliases = data.aliases;
      freshWritten.set(qKey, written.get(qKey) as string);
    }
    return { data: fresh, written: freshWritten, legacyPending: false };
  }
  return { data, written, legacyPending: false };
}

async function getState(profileId: string): Promise<ProfileState> {
  const cached = cache.get(profileId);
  if (cached) return cached;
  let pending = loading.get(profileId);
  if (!pending) {
    pending = readProfile(profileId)
      .catch(
        (): ProfileState => ({
          data: emptyData(),
          written: new Map<string, string>(),
          legacyPending: false,
          readFailed: true,
        }),
      )
      .then((state) => {
        cache.set(profileId, state);
        return state;
      })
      .finally(() => loading.delete(profileId));
    loading.set(profileId, pending);
  }
  return pending;
}

export async function loadOfflineData(profileId: string): Promise<OfflineData> {
  return (await getState(profileId)).data;
}

export async function saveOfflineData(profileId: string, data: OfflineData): Promise<void> {
  const state = await getState(profileId);
  state.data = data;
  const prev = writeChains.get(profileId) ?? Promise.resolve();
  // A write failure loses no data: it is in memory and written is not updated —
  // the next save will retry writing the changed entries.
  const next = prev.then(() => persist(profileId, state).catch(() => {}));
  writeChains.set(profileId, next);
  return next;
}

/**
 * Like saveOfflineData, but a write failure is rethrown. Needed where the write
 * is followed by an irreversible step (deleting the source file during migration).
 */
export async function saveOfflineDataStrict(profileId: string, data: OfflineData): Promise<void> {
  const state = await getState(profileId);
  state.data = data;
  const prev = writeChains.get(profileId) ?? Promise.resolve();
  const next = prev.then(() => persist(profileId, state));
  writeChains.set(profileId, next.catch(() => {}));
  await next;
  if (state.legacyPending && !state.webLegacyOps) throw new Error('legacy data not converted');
}

/** Convenience mutate: load, apply the mutation, save. */
export async function updateOfflineData(
  profileId: string,
  mutate: (data: OfflineData) => void,
): Promise<OfflineData> {
  const data = await loadOfflineData(profileId);
  mutate(data);
  await saveOfflineData(profileId, data);
  return data;
}

/**
 * Profile cache migration at startup. true = no legacy plaintext is left
 * (or there never was any); false = conversion failed, retry on the next launch.
 */
export async function migrateOfflineProfile(profileId: string): Promise<boolean> {
  const state = await getState(profileId);
  return !state.legacyPending || Boolean(state.webLegacyOps);
}

/**
 * Full reset of a profile's local data (e.g. when a server is removed):
 * cache, queue, data key, pending attachment files, legacy blob.
 */
export async function clearOfflineData(profileId: string): Promise<void> {
  const state = cache.get(profileId);
  cache.delete(profileId);
  clearedProfiles.add(profileId);
  const prev = writeChains.get(profileId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const uris = (state?.data.pending ?? [])
      .map((op) => op.payload.localUri)
      .filter((uri): uri is string => Boolean(uri));
    await deletePendingAttachmentFiles(profileId, uris).catch(() => {});
    await encryptedCache.clearServer(profileId).catch(() => {});
    await AsyncStorage.removeItem(legacyOfflineKey(profileId)).catch(() => {});
  });
  writeChains.set(profileId, next);
  await next;
}

/** Resolve a temporary id to the server id if sync has already happened. */
export function resolveNoteId(data: OfflineData, id: number): number {
  let current = id;
  const seen = new Set<number>();
  while (current < 0 && data.aliases[String(current)] !== undefined && !seen.has(current)) {
    seen.add(current);
    current = data.aliases[String(current)];
  }
  return current;
}

export function makeOpId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Tests only: forget the in-memory state (simulates an app restart). */
export function __resetOfflineMemoryForTests(): void {
  cache.clear();
  loading.clear();
  writeChains.clear();
  clearedProfiles.clear();
}
