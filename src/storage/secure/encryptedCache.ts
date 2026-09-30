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
 * Зашифрованный кэш поверх AsyncStorage (на web — поверх памяти сессии).
 *
 * Scope определяет ключ данных (DEK): у каждого сервера свой
 * `pozzy.server.<id>.dek`, у общих для приложения данных (чат, шаблоны) —
 * `pozzy.app.dek`. Каждое значение шифруется отдельно, со случайным nonce и
 * ключом хранилища в качестве associated data.
 *
 * Значение без префикса `enc:` — legacy-открытый текст: при чтении
 * возвращается как есть и тут же перешифровывается на месте.
 * Нечитаемое значение (нет ключа данных, подмена, повреждение) удаляется и
 * возвращается в списке unreadable — вызывающий решает, что это значит.
 */

/** Scope для данных приложения, не привязанных к серверу. */
export const APP_SCOPE = '@app';

export type CacheScope = string;

function dataKeyName(scope: CacheScope): string {
  return scope === APP_SCOPE ? secretKeys.appDataKey : secretKeys.serverDataKey(scope);
}

/** Префикс всех записей кэша сервера. */
export function serverCachePrefix(serverId: string): string {
  return `pozzy.cache.${keySegment(serverId)}.`;
}

// ===== Ключи данных =====

const dataKeys = new Map<CacheScope, Uint8Array>();
const dataKeyLocks = new Map<CacheScope, Promise<unknown>>();
// Удалённые серверы: запоздавшая запись не должна воссоздать ключ данных и кэш
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
    // Нет ключа (первый запуск, восстановление из бэкапа) или он повреждён:
    // создаём новый. Данные под старым ключом уже нечитаемы.
    const encoded = generateDataKey();
    if (!(await secrets.setVerified(name, encoded))) {
      throw new Error('data key unavailable');
    }
    const key = decodeDataKey(encoded) as Uint8Array;
    dataKeys.set(scope, key);
    return key;
  });
}

// ===== Очередь записей =====

// Все записи scope идут по одной цепочке, чтения ждут её хвост:
// чтение после записи всегда видит записанное.
const writeLocks = new Map<CacheScope, Promise<unknown>>();

function enqueueWrite<T>(scope: CacheScope, fn: () => Promise<T>): Promise<T> {
  return serialize(writeLocks, scope, fn);
}

async function waitWrites(scope: CacheScope): Promise<void> {
  await (writeLocks.get(scope) ?? Promise.resolve());
}

export interface CacheReadResult {
  values: Map<string, string>;
  /** Ключи, значения которых не удалось расшифровать (они уже удалены). */
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
    // Перешифровываем legacy на месте. Перед записью перечитываем: если значение
    // успели перезаписать, не затираем более новое. Ошибка не мешает чтению.
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
        // перед заменой исходника убеждаемся, что конверт расшифровывается
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
  /** false = кэш живёт только в рамках сессии (web). */
  persistent: cacheBackend.persistent,

  async get(scope: CacheScope, key: string): Promise<string | null> {
    const { values } = await readMany(scope, [key]);
    return values.get(key) ?? null;
  },

  getMany: readMany,

  async set(scope: CacheScope, key: string, value: string): Promise<void> {
    await writeMany(scope, [[key, value]]);
  },

  /** Атомарно, насколько позволяет платформа (Android: одна транзакция). */
  setMany: writeMany,

  /** Записать, прочитать обратно, расшифровать и сравнить (для миграции). */
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
   * Миграция: зашифровать legacy-значения на месте с проверкой обратным
   * чтением. true = под этими ключами не осталось открытого текста.
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
          // Проверка не прошла — возвращаем исходник, чтобы не потерять данные
          await enqueueWrite(scope, () => cacheBackend.setItem(key, raw)).catch(() => {});
        }
      } catch {
        ok = false;
      }
    }
    return ok;
  },

  /** Все ключи хранилища с префиксом. */
  async keysWithPrefix(prefix: string): Promise<string[]> {
    const all = await cacheBackend.getAllKeys();
    return all.filter((k) => k.startsWith(prefix));
  },

  /** Удалить весь кэш сервера и его ключ данных; дальнейшие записи scope отклоняются. */
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

  /** Шифрование бинарных данных (файлы вложений) ключом scope. */
  async encryptBytes(scope: CacheScope, bytes: Uint8Array, associatedData: string): Promise<string> {
    const key = (await loadDataKey(scope, true)) as Uint8Array;
    return encryptBytes(key, bytes, associatedData);
  },

  /** null = ключа данных нет или содержимое не проходит проверку. */
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

  /** Есть ли у scope ключ данных (без создания). */
  async hasDataKey(scope: CacheScope): Promise<boolean> {
    return (await loadDataKey(scope, false)) !== null;
  },
};

/** Только для тестов: сбросить закэшированные в памяти ключи данных. */
export function __resetDataKeyCacheForTests(): void {
  dataKeys.clear();
  dataKeyLocks.clear();
  writeLocks.clear();
  closedScopes.clear();
}
