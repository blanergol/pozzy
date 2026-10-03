import { SecretBackend } from './types';

// expo-secure-store is unavailable on web: secrets are kept only in the tab's memory,
// after a reload the password has to be entered again.
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
