import { CacheBackend } from './types';

// On web the offline cache lives only for the session: without SecureStore the data key
// can't be persisted anyway, and ciphertext next to its key in localStorage is useless.
const memory = new Map<string, string>();

export const cacheBackend: CacheBackend = {
  persistent: false,
  getItem: async (key) => memory.get(key) ?? null,
  setItem: async (key, value) => {
    memory.set(key, value);
  },
  removeItem: async (key) => {
    memory.delete(key);
  },
  multiGet: async (keys) => keys.map((key) => [key, memory.get(key) ?? null] as const),
  multiSet: async (pairs) => {
    for (const [key, value] of pairs) memory.set(key, value);
  },
  multiRemove: async (keys) => {
    for (const key of keys) memory.delete(key);
  },
  getAllKeys: async () => Array.from(memory.keys()),
};
