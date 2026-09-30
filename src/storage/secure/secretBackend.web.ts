import { SecretBackend } from './types';

// expo-secure-store на web недоступен: секреты держим только в памяти вкладки,
// после перезагрузки пароль придётся ввести заново.
const memory = new Map<string, string>();

export const secretBackend: SecretBackend = {
  persistent: false,
  get: async (key) => memory.get(key) ?? null,
  set: async (key, value) => {
    memory.set(key, value);
  },
  delete: async (key) => {
    memory.delete(key);
  },
};
