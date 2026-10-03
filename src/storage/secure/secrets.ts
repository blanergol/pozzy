import { secretBackend } from './secretBackend';

/**
 * Secrets (server passwords, API keys, data keys) — only through this module.
 *
 * SecureStore can't enumerate entries, and the iOS Keychain survives app
 * uninstall. So all written keys are tracked in the `pozzy.keys` index
 * (also in SecureStore): on a fresh install leftovers are deleted by it.
 * A key is added to the index BEFORE its value is written, so an interruption
 * leaves a superset in the index — which is safe.
 */

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const INDEX_KEY = 'pozzy.keys';
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 50;

/** The secret could not be read even after retries. The message contains no data. */
export class SecretReadError extends Error {
  constructor() {
    super('secret read failed');
    this.name = 'SecretReadError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Identifier → SecureStore key segment ([A-Za-z0-9._-]). */
export function keySegment(id: string): string {
  if (/^[A-Za-z0-9-]+$/.test(id)) return id;
  // "." and "_" are reserved for the separator and the escape
  return id.replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}_`);
}

export const secretKeys = {
  serverPassword: (serverId: string) => `pozzy.server.${keySegment(serverId)}.password`,
  serverDataKey: (serverId: string) => `pozzy.server.${keySegment(serverId)}.dek`,
  aiApiKey: (providerId = 'default') => `pozzy.ai.${keySegment(providerId)}.apiKey`,
  appDataKey: 'pozzy.app.dek',
} as const;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key) || !key.startsWith('pozzy.')) {
    throw new Error('invalid secret key');
  }
}

// Index changes are serialized: concurrent set/delete would otherwise lose entries
let indexChain: Promise<unknown> = Promise.resolve();

function withIndex<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexChain.then(fn, fn);
  indexChain = next.catch(() => {});
  return next;
}

async function readIndex(): Promise<string[]> {
  try {
    const raw = await secretBackend.get(INDEX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIndex(keys: string[]): Promise<void> {
  if (keys.length === 0) {
    await secretBackend.delete(INDEX_KEY);
  } else {
    await secretBackend.set(INDEX_KEY, JSON.stringify(keys));
  }
}

export const secrets = {
  /** true = secrets survive a restart (native platforms). */
  persistent: secretBackend.persistent,

  /**
   * null = no value. A read error is retried several times (on some
   * Android devices the Keystore occasionally responds with an error); if it persists —
   * SecretReadError. The caller decides: for a data key this means "unreadable key",
   * for a password — "unknown", and such a password must not be deleted.
   */
  async read(key: string): Promise<string | null> {
    assertKey(key);
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      try {
        return await secretBackend.get(key);
      } catch {
        // the platform error text is not propagated
        if (attempt < READ_ATTEMPTS - 1) await delay(READ_RETRY_MS * (attempt + 1));
      }
    }
    throw new SecretReadError();
  },

  /** Like read, but a persistent read error → null. */
  async get(key: string): Promise<string | null> {
    try {
      return await secrets.read(key);
    } catch (e) {
      if (e instanceof SecretReadError) return null;
      throw e;
    }
  },

  async set(key: string, value: string): Promise<void> {
    assertKey(key);
    await withIndex(async () => {
      const index = await readIndex();
      if (!index.includes(key)) await writeIndex([...index, key]);
    });
    await secretBackend.set(key, value);
  },

  /** Write and read back; false = the stored value did not match. */
  async setVerified(key: string, value: string): Promise<boolean> {
    try {
      await secrets.set(key, value);
    } catch {
      return false;
    }
    return (await secrets.get(key)) === value;
  },

  async delete(key: string): Promise<void> {
    assertKey(key);
    await secretBackend.delete(key);
    await withIndex(async () => {
      const index = await readIndex();
      if (index.includes(key)) await writeIndex(index.filter((k) => k !== key));
    });
  },

  /** Delete all secrets of a server: the password and the data key. */
  async deleteServer(serverId: string): Promise<void> {
    await secrets.delete(secretKeys.serverPassword(serverId));
    await secrets.delete(secretKeys.serverDataKey(serverId));
  },

  /**
   * Delete everything the app has ever written (by the index).
   * Used on a fresh install: on iOS the Keychain survives uninstall.
   */
  async deleteAll(): Promise<void> {
    await withIndex(async () => {
      const index = await readIndex();
      for (const key of index) {
        await secretBackend.delete(key).catch(() => {});
      }
      await secretBackend.delete(INDEX_KEY).catch(() => {});
    });
  },
};
