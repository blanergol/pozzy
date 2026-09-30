import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Учёт потерянных несинхронизированных правок: очередь сервера оказалась
 * нечитаемой (нет ключа данных после восстановления из бэкапа, смена
 * устройства, повреждение). Флаг переживает перезапуск, пока пользователь
 * не увидит сообщение. Хранятся только id профилей — без содержимого.
 */

const LOST_EDITS_KEY = 'pozzy.lostEdits.v1';

type Listener = () => void;
const listeners = new Set<Listener>();

let chain: Promise<unknown> = Promise.resolve();

async function readIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(LOST_EDITS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function recordLostEdits(serverId: string): Promise<void> {
  const next = chain.then(async () => {
    const ids = await readIds();
    if (!ids.includes(serverId)) {
      await AsyncStorage.setItem(LOST_EDITS_KEY, JSON.stringify([...ids, serverId]));
    }
  });
  chain = next.catch(() => {});
  return next.then(
    () => listeners.forEach((l) => l()),
    () => listeners.forEach((l) => l()),
  );
}

/** Забрать список серверов с потерянными правками и сбросить флаг. */
export function takeLostEdits(): Promise<string[]> {
  const next = chain.then(async () => {
    const ids = await readIds();
    if (ids.length > 0) await AsyncStorage.removeItem(LOST_EDITS_KEY);
    return ids;
  });
  chain = next.catch(() => {});
  return next.catch(() => []);
}

export function subscribeLostEdits(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
