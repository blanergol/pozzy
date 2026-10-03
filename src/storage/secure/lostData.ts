import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Tracking of lost unsynced edits: the server's queue turned out to be
 * unreadable (no data key after a restore from backup, device change,
 * corruption). The flag survives restarts until the user sees the message.
 * Only profile ids are stored — no content.
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

/** Take the list of servers with lost edits and reset the flag. */
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
