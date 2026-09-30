import { secretBackend } from './secretBackend';

/**
 * Секреты (пароли серверов, API-ключи, ключи данных) — только через этот модуль.
 *
 * SecureStore не умеет перечислять записи, а iOS Keychain переживает удаление
 * приложения. Поэтому все записанные ключи ведутся в индексе `pozzy.keys`
 * (тоже в SecureStore): по нему при чистой установке удаляются остатки.
 * Ключ попадает в индекс ДО записи значения, так что прерывание оставляет
 * в индексе надмножество — безопасно.
 */

const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
const INDEX_KEY = 'pozzy.keys';
const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 50;

/** Секрет не удалось прочитать даже после повторов. Сообщение без данных. */
export class SecretReadError extends Error {
  constructor() {
    super('secret read failed');
    this.name = 'SecretReadError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Идентификатор → сегмент ключа SecureStore ([A-Za-z0-9._-]). */
export function keySegment(id: string): string {
  if (/^[A-Za-z0-9-]+$/.test(id)) return id;
  // "." и "_" зарезервированы под разделитель и escape
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

// Изменения индекса сериализуем: конкурентные set/delete иначе теряют записи
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
  /** true = секреты переживают перезапуск (нативные платформы). */
  persistent: secretBackend.persistent,

  /**
   * null = значения нет. Ошибка чтения повторяется несколько раз (на части
   * Android-устройств Keystore изредка отвечает ошибкой); если она стабильна —
   * SecretReadError. Вызывающий решает: для ключа данных это «нечитаемый ключ»,
   * для пароля — «неизвестно», и удалять такой пароль нельзя.
   */
  async read(key: string): Promise<string | null> {
    assertKey(key);
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      try {
        return await secretBackend.get(key);
      } catch {
        // текст ошибки платформы не пробрасываем
        if (attempt < READ_ATTEMPTS - 1) await delay(READ_RETRY_MS * (attempt + 1));
      }
    }
    throw new SecretReadError();
  },

  /** Как read, но стабильная ошибка чтения → null. */
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

  /** Записать и прочитать обратно; false = значение в хранилище не совпало. */
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

  /** Удалить все секреты сервера: пароль и ключ данных. */
  async deleteServer(serverId: string): Promise<void> {
    await secrets.delete(secretKeys.serverPassword(serverId));
    await secrets.delete(secretKeys.serverDataKey(serverId));
  },

  /**
   * Удалить всё, что приложение когда-либо записало (по индексу).
   * Используется при чистой установке: на iOS Keychain переживает удаление.
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
