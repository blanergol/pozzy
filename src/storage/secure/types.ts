/** Хранилище секретов: SecureStore на iOS/Android, память на web. */
export interface SecretBackend {
  /** false = секреты живут только до перезагрузки (web). */
  readonly persistent: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Хранилище зашифрованного кэша: AsyncStorage на iOS/Android, память на web. */
export interface CacheBackend {
  /** false = кэш живёт только в рамках сессии (web). */
  readonly persistent: boolean;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  /** На Android — одна SQLite-транзакция. */
  multiSet(pairs: [string, string][]): Promise<void>;
  multiRemove(keys: readonly string[]): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}
