/**
 * Single entry point for sensitive data. The rest of the code does not access
 * SecureStore directly and does not write secrets/note contents to AsyncStorage.
 *
 *   secrets        — passwords, API keys, data keys (SecureStore; web — memory)
 *   encryptedCache — encrypted cache (AsyncStorage; web — session memory)
 */
export { secrets, secretKeys } from './secrets';
export { APP_SCOPE, encryptedCache } from './encryptedCache';
export { runStartupMigration } from './migration';
export { subscribeLostEdits, takeLostEdits } from './lostData';
