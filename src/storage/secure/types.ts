/** Secret storage: SecureStore on iOS/Android, memory on web. */
export interface SecretBackend {
  /** false = secrets live only until a reload (web). */
  readonly persistent: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Encrypted cache storage: AsyncStorage on iOS/Android, memory on web. */
export interface CacheBackend {
  /** false = the cache lives only for the session (web). */
  readonly persistent: boolean;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  /** On Android — a single SQLite transaction. */
  multiSet(pairs: [string, string][]): Promise<void>;
  multiRemove(keys: readonly string[]): Promise<void>;
  getAllKeys(): Promise<readonly string[]>;
}
