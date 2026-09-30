import AsyncStorage from '@react-native-async-storage/async-storage';
import { Folder, NoteDetails, NoteListItem } from '../api/types';
import { encryptedCache, serverCachePrefix } from './secure/encryptedCache';
import { deletePendingAttachmentFiles } from './secure/encryptedFiles';
import { recordLostEdits } from './secure/lostData';

/** Заметка в локальном кэше; localUpdatedAt — время последней ЛОКАЛЬНОЙ правки (ISO). */
export interface CachedNote extends NoteDetails {
  localUpdatedAt?: string;
}

/** Операция, ожидающая синхронизации с сервером. */
export interface PendingOp {
  opId: string;
  type: 'create' | 'update' | 'delete' | 'favorite' | 'attachment';
  /** id заметки; у оффлайн-созданных — временный отрицательный. */
  noteId: number;
  payload: {
    heading?: string;
    content?: string;
    tags?: string;
    workspace?: string;
    folder_id?: number | null;
    /** Целевое состояние избранного (для type='favorite'). */
    favorite?: number;
    /** Отложенная загрузка вложения (type='attachment'): локальная копия файла. */
    localUri?: string;
    fileName?: string;
    mimeType?: string;
  };
  /** ISO-время локального изменения — основа last-write-wins. */
  clientTs: string;
}

export interface OfflineData {
  /** Снимок списка заметок (серверный + наложенные локальные правки). */
  notesList: NoteListItem[];
  /** Полные заметки по id (строка). */
  notesDetails: Record<string, CachedNote>;
  folders: Folder[];
  /** Очередь несинхронизированных операций. */
  pending: PendingOp[];
  /** Перепривязка временных id → серверные после синхронизации create. */
  aliases: Record<string, number>;
}

function emptyData(): OfflineData {
  // Каждый раз новые массивы/объекты: иначе профили делят общий EMPTY.notesList
  return { notesList: [], notesDetails: {}, folders: [], pending: [], aliases: {} };
}

/*
 * Раскладка в хранилище (все значения зашифрованы ключом данных сервера):
 *   pozzy.cache.<id>.queue        — очередь + aliases (только пока очередь не пуста).
 *                                   aliases лежат в той же записи, что и очередь:
 *                                   запись одного ключа атомарна на всех платформах,
 *                                   а multiSet на iOS — нет (сбой между «create ушёл»
 *                                   и «alias записан» иначе терял бы правки)
 *   pozzy.cache.<id>.meta         — список заметок, папки, aliases, маркер конвертации
 *   pozzy.cache.<id>.note.<noteId> — полная заметка
 * При сохранении пишутся только изменившиеся записи, одним multiSet
 * (на Android — одна транзакция), очередь — первой.
 *
 * Legacy (до 1.1): один открытый JSON `poznote.offline.<id>.v1`. Он
 * конвертируется при первом чтении; до успешной проверенной записи нового
 * формата legacy-блоб остаётся источником истины и не удаляется.
 */

export function legacyOfflineKey(profileId: string): string {
  return `poznote.offline.${profileId}.v1`;
}

const queueKey = (profileId: string) => `${serverCachePrefix(profileId)}queue`;
const metaKey = (profileId: string) => `${serverCachePrefix(profileId)}meta`;
const notePrefix = (profileId: string) => `${serverCachePrefix(profileId)}note.`;

interface ProfileState {
  data: OfflineData;
  /** Ключ хранилища → JSON, записанный последним (база для отслеживания изменений). */
  written: Map<string, string>;
  /** Legacy-блоб ещё не удалён: следующая запись должна быть полной. */
  legacyPending: boolean;
  /** Web: opId операций из legacy-блоба, которые ещё не синхронизированы. */
  webLegacyOps?: Set<string>;
  /** Хранилище не прочиталось: писать нельзя, пока не перечитаем (иначе затрём очередь). */
  readFailed?: boolean;
}

// Маркер «запись есть, содержимое неизвестно» — гарантирует перезапись/удаление
const UNKNOWN = '\u0000';

// In-memory кэш поверх хранилища: сериализуем чтение/запись, чтобы
// конкурентные правки (автосохранение + синхронизация) не теряли данные.
const cache = new Map<string, ProfileState>();
const loading = new Map<string, Promise<ProfileState>>();
const writeChains = new Map<string, Promise<void>>();
// Удалённые профили: запоздавший синк не должен воссоздать их кэш и ключ данных
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
  // порядок вставки = порядок записи: очередь первой
  if (data.pending.length > 0) entries.set(queueKey(profileId), queueJson(data));
  for (const [id, note] of Object.entries(data.notesDetails)) {
    entries.set(notePrefix(profileId) + id, JSON.stringify(note));
  }
  entries.set(
    metaKey(profileId),
    // converted: запись нового формата сделана после проверенного переноса очереди —
    // оставшийся legacy-блоб устарел и не должен её перезаписать
    JSON.stringify({ notesList: data.notesList, folders: data.folders, aliases: data.aliases, converted: true }),
  );
  return entries;
}

/** Слить данные, прочитанные из хранилища, в данные в памяти (мутирует mem). */
function mergeStored(mem: OfflineData, stored: OfflineData): void {
  const memOps = new Set(mem.pending.map((op) => op.opId));
  mem.pending = [...stored.pending.filter((op) => !memOps.has(op.opId)), ...mem.pending];
  mem.notesDetails = { ...stored.notesDetails, ...mem.notesDetails };
  mem.aliases = { ...stored.aliases, ...mem.aliases };
  if (mem.notesList.length === 0) mem.notesList = stored.notesList;
  if (mem.folders.length === 0) mem.folders = stored.folders;
}

/** Записать изменившиеся записи. Ошибка — исключение; written обновляется только по успеху. */
async function persist(profileId: string, state: ProfileState): Promise<void> {
  if (clearedProfiles.has(profileId)) return;
  if (state.readFailed) {
    // При загрузке хранилище не прочиталось. Писать поверх нельзя — затрём
    // сохранённую очередь; сначала перечитываем и сливаем с правками в памяти.
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
  // Опустевшую очередь сначала перезаписываем "[]" в той же транзакции, что и
  // остальное (aliases и т.п.), и только потом удаляем: иначе сбой между
  // записью и удалением воскресил бы уже отправленные операции (дубли create).
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
    // Legacy-блоб удаляем только после проверки обратным чтением
    const { values } = await encryptedCache.getMany(profileId, [...entries.keys()]);
    for (const [key, json] of entries) {
      if (values.get(key) !== json) throw new Error('verification failed');
    }
    await AsyncStorage.removeItem(legacyOfflineKey(profileId));
    state.legacyPending = false;
  }
}

/**
 * Web: кэш живёт в памяти, поэтому несинхронизированные правки прошлой версии
 * нельзя сразу удалить из localStorage — перезагрузка страницы их бы потеряла.
 * Держим в legacy-ключе только ещё не отправленные legacy-операции и удаляем
 * его, как только они уйдут на сервер.
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

/** Все записи нового формата сервера, помеченные как «неизвестные». */
async function existingEntries(profileId: string): Promise<Map<string, string>> {
  const keys = await encryptedCache.keysWithPrefix(serverCachePrefix(profileId));
  return new Map(keys.map((key) => [key, UNKNOWN]));
}

/** Конвертация legacy-блоба: очередь первой и с проверкой, затем остальное. */
async function convertLegacy(profileId: string, data: OfflineData): Promise<ProfileState> {
  const state: ProfileState = { data, written: new Map(), legacyPending: true };
  if (!encryptedCache.persistent) {
    // web: переносим в память сессии, legacy-правки дренируются по мере синка
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
    // Остальное: запись → проверка обратным чтением → удаление legacy (в persist)
    await persist(profileId, state);
  } catch {
    // Шифрованное хранилище недоступно: работаем с legacy-данными в памяти,
    // legacy-блоб остаётся на диске до первой успешной полной записи.
    state.legacyPending = true;
    state.written = await existingEntries(profileId).catch(() => new Map());
  }
  return state;
}

/** Есть ли читаемая meta нового формата, записанная после конвертации. */
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
      // нечитаемый legacy-JSON и раньше заменялся пустыми данными
      await AsyncStorage.removeItem(legacyOfflineKey(profileId)).catch(() => {});
    } else if (legacy) {
      if (!(await isConverted(profileId))) return await convertLegacy(profileId, legacy);
      // Сбой между проверенной записью нового формата и удалением legacy:
      // новый формат актуальнее (в нём могли быть правки после конвертации)
      if (encryptedCache.persistent) await AsyncStorage.removeItem(legacyOfflineKey(profileId));
    }
  } catch {
    // AsyncStorage недоступен — пробуем новый формат
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

  // aliases из записи очереди новее или равны тем, что в meta
  data.aliases = { ...metaAliases, ...queueAliases };

  if (queueLost) await recordLostEdits(profileId).catch(() => {});
  if (unreadable.length > 0) {
    // Ключ данных потерян (восстановление из бэкапа, другое устройство) или
    // записи повреждены: кэш считаем утраченным и перезагружаем с сервера.
    // Читаемую очередь (и aliases для её временных id) сохраняем — операции
    // самодостаточны и уйдут на сервер при синке.
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
  // Ошибка записи не теряет данные: они в памяти, written не обновлён —
  // следующее сохранение повторит запись изменившихся записей.
  const next = prev.then(() => persist(profileId, state).catch(() => {}));
  writeChains.set(profileId, next);
  return next;
}

/**
 * Как saveOfflineData, но ошибка записи пробрасывается. Нужна там, где за
 * записью следует необратимый шаг (удаление исходного файла при миграции).
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

/** Удобный mutate: загрузить, применить мутацию, сохранить. */
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
 * Миграция кэша профиля при старте. true = legacy-открытого текста больше нет
 * (или не было); false = конвертация не удалась, повторим при следующем запуске.
 */
export async function migrateOfflineProfile(profileId: string): Promise<boolean> {
  const state = await getState(profileId);
  return !state.legacyPending || Boolean(state.webLegacyOps);
}

/**
 * Полный сброс локальных данных профиля (например при удалении сервера):
 * кэш, очередь, ключ данных, файлы ожидающих вложений, legacy-блоб.
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

/** Разрешить временный id в серверный, если синхронизация уже прошла. */
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

/** Только для тестов: забыть in-memory состояние (эмуляция перезапуска). */
export function __resetOfflineMemoryForTests(): void {
  cache.clear();
  loading.clear();
  writeChains.clear();
  clearedProfiles.clear();
}
