import { cacheBackend } from './cacheBackend';
import {
  decodeDataKey,
  decryptBytes,
  decryptString,
  encryptBytes,
  encryptString,
  generateDataKey,
  isEnvelope,
} from './crypto';
import { keySegment, secretKeys, secrets } from './secrets';

/**
 * Encrypted cache on top of AsyncStorage (on web — on top of session memory).
 *
 * The scope determines the data key (DEK): each server has its own
 * `pozzy.server.<id>.dek`, app-wide data (chat, templates) uses
 * `pozzy.app.dek`. Each value is encrypted separately, with a random nonce and
 * the storage key as associated data.
 *
 * A value without the `enc:` prefix is legacy plaintext: on read it is
 * returned as is and immediately re-encrypted in place.
 * An unreadable value (no data key, tampering, corruption) is deleted and
 * returned in the unreadable list — the caller decides what that means.
 */

/** Scope for app data not tied to a server. */
export const APP_SCOPE = '@app';

export type CacheScope = string;

function dataKeyName(scope: CacheScope): string {
  return scope === APP_SCOPE ? secretKeys.appDataKey : secretKeys.serverDataKey(scope);
}

/** Prefix of all cache entries of a server. */
export function serverCachePrefix(serverId: string): string {
  return `pozzy.cache.${keySegment(serverId)}.`;
}

// ===== Data keys =====

const dataKeys = new Map<CacheScope, Uint8Array>();
const dataKeyLocks = new Map<CacheScope, Promise<unknown>>();
// Removed servers: a late write must not recreate the data key and the cache
const closedScopes = new Set<CacheScope>();

class ScopeClosedError extends Error {
  constructor() {
    super('cache scope closed');
    this.name = 'ScopeClosedError';
  }
}

function serialize<T>(locks: Map<string, Promise<unknown>>, id: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

async function loadDataKey(scope: CacheScope, create: boolean): Promise<Uint8Array | null> {
  const cached = dataKeys.get(scope);
  if (cached) return cached;
  return serialize(dataKeyLocks, scope, async () => {
    const again = dataKeys.get(scope);
    if (again) return again;
    const name = dataKeyName(scope);
    const stored = await secrets.get(name);
    const decoded = stored ? decodeDataKey(stored) : null;
    if (decoded) {
      dataKeys.set(scope, decoded);
      return decoded;
    }
    if (!create) return null;
    if (closedScopes.has(scope)) throw new ScopeClosedError();
    // No key (first launch, restore from backup) or it is corrupted:
    // create a new one. Data under the old key is already unreadable.
    const encoded = generateDataKey();
    if (!(await secrets.setVerified(name, encoded))) {
      throw new Error('data key unavailable');
    }
    const key = decodeDataKey(encoded) as Uint8Array;
    dataKeys.set(scope, key);
    return key;
  });
}

// ===== Write queue =====

// All writes of a scope go through a single chain, reads wait for its tail:
// a read after a write always sees what was written.
const writeLocks = new Map<CacheScope, Promise<unknown>>();

function enqueueWrite<T>(scope: CacheScope, fn: () => Promise<T>): Promise<T> {
  return serialize(writeLocks, scope, fn);
}

async function waitWrites(scope: CacheScope): Promise<void> {
  await (writeLocks.get(scope) ?? Promise.resolve());
}

export interface CacheReadResult {
  values: Map<string, string>;
  /** Keys whose values could not be decrypted (they have already been deleted). */
  unreadable: string[];
}

async function readMany(scope: CacheScope, keys: readonly string[]): Promise<CacheReadResult> {
  await waitWrites(scope);
  const values = new Map<string, string>();
  const unreadable: string[] = [];
  if (keys.length === 0) return { values, unreadable };
  const rows = await cacheBackend.multiGet(keys);
  const legacy: [string, string][] = [];
  let dataKey: Uint8Array | null | undefined;
  for (const [key, raw] of rows) {
    if (raw === null || raw === undefined) continue;
    if (!isEnvelope(raw)) {
      values.set(key, raw);
      legacy.push([key, raw]);
      continue;
    }
    if (dataKey === undefined) dataKey = await loadDataKey(scope, false);
    if (!dataKey) {
      unreadable.push(key);
      continue;
    }
    try {
      values.set(key, decryptString(dataKey, raw, key));
    } catch {
      unreadable.push(key);
    }
  }
  if (unreadable.length > 0) {
    await enqueueWrite(scope, () => cacheBackend.multiRemove(unreadable)).catch(() => {});
  }
  if (legacy.length > 0) {
    // Re-encrypt legacy values in place. Re-read before writing: if the value has
    // been overwritten meanwhile, don't clobber the newer one. An error doesn't block the read.
    await enqueueWrite(scope, async () => {
      const key = await loadDataKey(scope, true);
      if (!key) return;
      const current = await cacheBackend.multiGet(legacy.map(([k]) => k));
      const stillLegacy = new Set(
        current.filter(([k, v]) => v !== null && v === values.get(k)).map(([k]) => k),
      );
      const pairs = legacy
        .filter(([k]) => stillLegacy.has(k))
        .map(([k, v]) => [k, encryptString(key, v, k)] as [string, string])
        // before replacing the original, make sure the envelope decrypts
        .filter(([k, env]) => decryptString(key, env, k) === values.get(k));
      if (pairs.length > 0) await cacheBackend.multiSet(pairs);
    }).catch(() => {});
  }
  return { values, unreadable };
}

async function writeMany(scope: CacheScope, pairs: [string, string][]): Promise<void> {
  if (pairs.length === 0) return;
  if (closedScopes.has(scope)) throw new ScopeClosedError();
  await enqueueWrite(scope, async () => {
    if (closedScopes.has(scope)) throw new ScopeClosedError();
    const key = (await loadDataKey(scope, true)) as Uint8Array;
    await cacheBackend.multiSet(pairs.map(([k, v]) => [k, encryptString(key, v, k)]));
  });
}

async function removeMany(scope: CacheScope, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await enqueueWrite(scope, () => cacheBackend.multiRemove(keys));
}

export const encryptedCache = {
  /** false = the cache lives only for the session (web). */
  persistent: cacheBackend.persistent,

  async get(scope: CacheScope, key: string): Promise<string | null> {
    const { values } = await readMany(scope, [key]);
    return values.get(key) ?? null;
  },

  getMany: readMany,

  async set(scope: CacheScope, key: string, value: string): Promise<void> {
    await writeMany(scope, [[key, value]]);
  },

  /** Atomic as far as the platform allows (Android: a single transaction). */
  setMany: writeMany,

  /** Write, read back, decrypt and compare (for migration). */
  async setVerified(scope: CacheScope, key: string, value: string): Promise<boolean> {
    try {
      await writeMany(scope, [[key, value]]);
      const { values } = await readMany(scope, [key]);
      return values.get(key) === value;
    } catch {
      return false;
    }
  },

  async delete(scope: CacheScope, key: string): Promise<void> {
    await removeMany(scope, [key]);
  },

  deleteMany: removeMany,

  /**
   * Migration: encrypt legacy values in place, verified by reading them back.
   * true = no plaintext is left under these keys.
   */
  async encryptInPlace(scope: CacheScope, keys: readonly string[]): Promise<boolean> {
    let ok = true;
    for (const key of keys) {
      try {
        await waitWrites(scope);
        const raw = await cacheBackend.getItem(key);
        if (raw === null || isEnvelope(raw)) continue;
        if (!(await encryptedCache.setVerified(scope, key, raw))) {
          ok = false;
          // Verification failed — put the original back so no data is lost
          await enqueueWrite(scope, () => cacheBackend.setItem(key, raw)).catch(() => {});
        }
      } catch {
        ok = false;
      }
    }
    return ok;
  },

  /** All storage keys with the given prefix. */
  async keysWithPrefix(prefix: string): Promise<string[]> {
    const all = await cacheBackend.getAllKeys();
    return all.filter((k) => k.startsWith(prefix));
  },

  /** Delete the server's entire cache and its data key; further writes to the scope are rejected. */
  async clearServer(serverId: string): Promise<void> {
    closedScopes.add(serverId);
    await enqueueWrite(serverId, async () => {
      const keys = (await cacheBackend.getAllKeys()).filter((k) =>
        k.startsWith(serverCachePrefix(serverId)),
      );
      if (keys.length > 0) await cacheBackend.multiRemove(keys);
      dataKeys.delete(serverId);
      await secrets.delete(secretKeys.serverDataKey(serverId));
    });
  },

  /** Encrypt binary data (attachment files) with the scope's key. */
  async encryptBytes(scope: CacheScope, bytes: Uint8Array, associatedData: string): Promise<string> {
    const key = (await loadDataKey(scope, true)) as Uint8Array;
    return encryptBytes(key, bytes, associatedData);
  },

  /** null = there is no data key or the content fails verification. */
  async decryptBytes(
    scope: CacheScope,
    envelope: string,
    associatedData: string,
  ): Promise<Uint8Array | null> {
    const key = await loadDataKey(scope, false);
    if (!key) return null;
    try {
      return decryptBytes(key, envelope, associatedData);
    } catch {
      return null;
    }
  },

  /** Whether the scope has a data key (without creating one). */
  async hasDataKey(scope: CacheScope): Promise<boolean> {
    return (await loadDataKey(scope, false)) !== null;
  },
};

/** Tests only: reset the in-memory cached data keys. */
export function __resetDataKeyCacheForTests(): void {
  dataKeys.clear();
  dataKeyLocks.clear();
  writeLocks.clear();
  closedScopes.clear();
}
