import { CacheBackend } from './types';

// На web оффлайн-кэш живёт только в рамках сессии: без SecureStore ключ данных
// всё равно нельзя сохранить, а шифротекст рядом с ключом в localStorage бесполезен.
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
