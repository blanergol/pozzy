import * as SecureStore from 'expo-secure-store';
import { SecretBackend } from './types';

/**
 * AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: доступно после первой разблокировки
 * (фоновые задачи тоже смогут читать) и не переезжает на другое устройство
 * через бэкап/миграцию. requireAuthentication намеренно НЕ используется:
 * биометрия остаётся UI-замком (AppLock), иначе смена отпечатков уничтожит ключи.
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
