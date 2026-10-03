import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SecretReadError, keySegment, secretKeys, secrets } from '../secrets';
import { secureStoreMock } from '../../../../test/secureTestUtils';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('secrets', () => {
  beforeEach(() => {
    secureStoreMock.__reset();
  });

  it('CRUD', async () => {
    const key = secretKeys.serverPassword('abc-1');
    expect(await secrets.get(key)).toBeNull();
    await secrets.set(key, 'p@ss');
    expect(await secrets.get(key)).toBe('p@ss');
    await secrets.set(key, 'new');
    expect(await secrets.get(key)).toBe('new');
    await secrets.delete(key);
    expect(await secrets.get(key)).toBeNull();
  });

  it('пишет с AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY и без requireAuthentication', async () => {
    await secrets.set(secretKeys.aiApiKey(), 'sk-1');
    await secrets.get(secretKeys.aiApiKey());
    const calls = secureStoreMock.__calls;
    expect(calls.filter((c) => c.op === 'set').length).toBeGreaterThan(0);
    for (const call of calls) {
      // 1 = AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY in the mock
      expect(call.options?.keychainAccessible).toBe(1);
      expect(call.options?.requireAuthentication).toBeUndefined();
    }
  });

  it('имена ключей по схеме и только из [A-Za-z0-9._-]', () => {
    expect(secretKeys.serverPassword('m1x2-ab')).toBe('pozzy.server.m1x2-ab.password');
    expect(secretKeys.serverDataKey('m1x2-ab')).toBe('pozzy.server.m1x2-ab.dek');
    expect(secretKeys.aiApiKey()).toBe('pozzy.ai.default.apiKey');
    expect(secretKeys.serverPassword('a b/ц.1')).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(keySegment('a.b')).not.toBe(keySegment('a_b'));
  });

  it('отклоняет недопустимые ключи', async () => {
    await expect(secrets.set('pozzy.bad key', 'x')).rejects.toThrow();
    await expect(secrets.set('other.key', 'x')).rejects.toThrow();
  });

  it('разовая ошибка чтения закрывается повтором', async () => {
    await secrets.set('pozzy.app.dek', 'k');
    secureStoreMock.__failNext('get', 2);
    expect(await secrets.get('pozzy.app.dek')).toBe('k');
  });

  it('стабильная ошибка чтения: read бросает SecretReadError без данных, get → null', async () => {
    await secrets.set('pozzy.app.dek', 'k');
    secureStoreMock.__failNext('get', 3);
    await expect(secrets.read('pozzy.app.dek')).rejects.toBeInstanceOf(SecretReadError);
    secureStoreMock.__failNext('get', 3);
    expect(await secrets.get('pozzy.app.dek')).toBeNull();
  });

  it('setVerified: false при сбое записи или расхождении при обратном чтении', async () => {
    secureStoreMock.__failNext('set', 5);
    expect(await secrets.setVerified('pozzy.app.dek', 'v')).toBe(false);
    secureStoreMock.__reset();
    secureStoreMock.__setCorruptReads(true);
    expect(await secrets.setVerified('pozzy.app.dek', 'v')).toBe(false);
    secureStoreMock.__setCorruptReads(false);
    expect(await secrets.setVerified('pozzy.app.dek', 'v')).toBe(true);
  });

  it('индекс ключей: deleteAll удаляет всё записанное, даже при параллельной записи', async () => {
    await Promise.all([
      secrets.set(secretKeys.serverPassword('s1'), 'a'),
      secrets.set(secretKeys.serverDataKey('s1'), 'b'),
      secrets.set(secretKeys.serverPassword('s2'), 'c'),
      secrets.set(secretKeys.aiApiKey(), 'd'),
    ]);
    expect(JSON.parse(secureStoreMock.__store.get('pozzy.keys') as string)).toHaveLength(4);
    await secrets.deleteAll();
    expect(secureStoreMock.__store.size).toBe(0);
  });

  it('deleteServer удаляет пароль и ключ данных только этого сервера', async () => {
    await secrets.set(secretKeys.serverPassword('s1'), 'a');
    await secrets.set(secretKeys.serverDataKey('s1'), 'b');
    await secrets.set(secretKeys.serverPassword('s2'), 'c');
    await secrets.deleteServer('s1');
    expect(await secrets.get(secretKeys.serverPassword('s1'))).toBeNull();
    expect(await secrets.get(secretKeys.serverDataKey('s1'))).toBeNull();
    expect(await secrets.get(secretKeys.serverPassword('s2'))).toBe('c');
    expect(JSON.parse(secureStoreMock.__store.get('pozzy.keys') as string)).toEqual([
      secretKeys.serverPassword('s2'),
    ]);
  });
});
