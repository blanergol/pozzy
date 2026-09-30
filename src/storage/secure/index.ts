/**
 * Единая точка доступа к чувствительным данным. Остальной код не обращается
 * к SecureStore напрямую и не пишет секреты/содержимое заметок в AsyncStorage.
 *
 *   secrets        — пароли, API-ключи, ключи данных (SecureStore; web — память)
 *   encryptedCache — зашифрованный кэш (AsyncStorage; web — память сессии)
 */
export { secrets, secretKeys } from './secrets';
export { APP_SCOPE, encryptedCache } from './encryptedCache';
export { runStartupMigration } from './migration';
export { subscribeLostEdits, takeLostEdits } from './lostData';
