import * as SecureStore from 'expo-secure-store';
import { SecretBackend } from './types';

/**
 * AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: accessible after the first unlock
 * (background tasks can read too) and does not move to another device
 * via backup/migration. requireAuthentication is deliberately NOT used:
 * biometrics stay a UI lock (AppLock), otherwise changing fingerprints would destroy the keys.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secretBackend: SecretBackend = {
  persistent: true,
  get: (key) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, OPTIONS),
  delete: (key) => SecureStore.deleteItemAsync(key, OPTIONS),
};
