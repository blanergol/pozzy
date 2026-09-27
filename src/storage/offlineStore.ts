import AsyncStorage from '@react-native-async-storage/async-storage';
import { Folder, NoteDetails, NoteListItem } from '../api/types';

/** Заметка в локальном кэше; localUpdatedAt — время последней ЛОКАЛЬНОЙ правки (ISO). */
export interface CachedNote extends NoteDetails {
  localUpdatedAt?: string;
}

/** Операция, ожидающая синхронизации с сервером. */
export interface PendingOp {
  opId: string;
  type: 'create' | 'update' | 'delete' | 'favorite';
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

function storageKey(profileId: string): string {
  return `poznote.offline.${profileId}.v1`;
}

// In-memory кэш поверх AsyncStorage: сериализуем чтение/запись, чтобы
// конкурентные правки (автосохранение + синхронизация) не теряли данные.
const cache = new Map<string, OfflineData>();
const writeChains = new Map<string, Promise<void>>();

export async function loadOfflineData(profileId: string): Promise<OfflineData> {
  const cached = cache.get(profileId);
  if (cached) return cached;
  try {
    const raw = await AsyncStorage.getItem(storageKey(profileId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<OfflineData>;
      const data: OfflineData = {
        notesList: Array.isArray(parsed.notesList) ? parsed.notesList : [],
        notesDetails: parsed.notesDetails ?? {},
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        aliases: parsed.aliases ?? {},
      };
      cache.set(profileId, data);
      return data;
    }
  } catch {
    // fallthrough — повреждённые данные заменяем пустыми
  }
  cache.set(profileId, emptyData());
  return cache.get(profileId)!;
}

export async function saveOfflineData(profileId: string, data: OfflineData): Promise<void> {
  cache.set(profileId, data);
  const prev = writeChains.get(profileId) ?? Promise.resolve();
  const next = prev.then(() =>
    AsyncStorage.setItem(storageKey(profileId), JSON.stringify(data)).catch(() => {}),
  );
  writeChains.set(profileId, next);
  return next;
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

/** Полный сброс локальных данных профиля (например при удалении сервера). */
export async function clearOfflineData(profileId: string): Promise<void> {
  cache.delete(profileId);
  await AsyncStorage.removeItem(storageKey(profileId)).catch(() => {});
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
