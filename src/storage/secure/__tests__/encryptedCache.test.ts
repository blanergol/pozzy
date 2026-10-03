import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { APP_SCOPE, encryptedCache } from '../encryptedCache';
import { secretKeys } from '../secrets';
import { rawAsyncStorage, restartApp, secureStoreMock, wipeDevice } from '../../../../test/secureTestUtils';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

describe('encryptedCache', () => {
  beforeEach(async () => {
    await wipeDevice();
  });

  it('значения на диске — конверты enc:v1 без открытого текста', async () => {
    await encryptedCache.set('s1', 'pozzy.cache.s1.meta', 'секретное содержимое');
    const raw = rawAsyncStorage()['pozzy.cache.s1.meta'];
    expect(raw.startsWith('enc:v1:')).toBe(true);
    expect(raw).not.toContain('секрет');
    expect(await encryptedCache.get('s1', 'pozzy.cache.s1.meta')).toBe('секретное содержимое');
  });

  it('ключ данных создаётся лениво, один на сервер, отдельный для приложения', async () => {
    await encryptedCache.set('s1', 'pozzy.cache.s1.a', '1');
    await encryptedCache.set('s2', 'pozzy.cache.s2.a', '2');
    await encryptedCache.set(APP_SCOPE, 'poznote.chatHistory.v1', '3');
    const store = secureStoreMock.__store;
    const k1 = store.get(secretKeys.serverDataKey('s1'));
    const k2 = store.get(secretKeys.serverDataKey('s2'));
    const k3 = store.get(secretKeys.appDataKey);
    expect(k1 && k2 && k3).toBeTruthy();
    expect(new Set([k1, k2, k3]).size).toBe(3);
  });

  it('параллельные первые записи не создают два разных ключа данных', async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => encryptedCache.set('s1', `pozzy.cache.s1.k${i}`, `v${i}`)),
    );
    restartApp();
    for (let i = 0; i < 5; i++) {
      expect(await encryptedCache.get('s1', `pozzy.cache.s1.k${i}`)).toBe(`v${i}`);
    }
  });

  it('legacy-открытый текст читается и сразу перешифровывается на месте', async () => {
    await AsyncStorage.setItem('poznote.chatHistory.v1', '[{"legacy":true}]');
    expect(await encryptedCache.get(APP_SCOPE, 'poznote.chatHistory.v1')).toBe('[{"legacy":true}]');
    expect(rawAsyncStorage()['poznote.chatHistory.v1'].startsWith('enc:v1:')).toBe(true);
    expect(await encryptedCache.get(APP_SCOPE, 'poznote.chatHistory.v1')).toBe('[{"legacy":true}]');
  });

  it('нет ключа данных → значения нечитаемы, удаляются, без исключений', async () => {
    await encryptedCache.set('s1', 'pozzy.cache.s1.a', 'data');
    secureStoreMock.__store.delete(secretKeys.serverDataKey('s1'));
    restartApp();
    const result = await encryptedCache.getMany('s1', ['pozzy.cache.s1.a']);
    expect(result.values.size).toBe(0);
    expect(result.unreadable).toEqual(['pozzy.cache.s1.a']);
    expect(rawAsyncStorage()['pozzy.cache.s1.a']).toBeUndefined();
    // after the key is lost, writing works again (with a new key)
    await encryptedCache.set('s1', 'pozzy.cache.s1.a', 'fresh');
    restartApp();
    expect(await encryptedCache.get('s1', 'pozzy.cache.s1.a')).toBe('fresh');
  });

  it('подменённое значение и значение, переложенное под другой ключ, отклоняются', async () => {
    await encryptedCache.set('s1', 'pozzy.cache.s1.a', 'A');
    await encryptedCache.set('s1', 'pozzy.cache.s1.b', 'B');
    const raw = rawAsyncStorage();
    raw['pozzy.cache.s1.b'] = raw['pozzy.cache.s1.a'];
    const tampered = raw['pozzy.cache.s1.a'];
    raw['pozzy.cache.s1.a'] = tampered.slice(0, -4) + (tampered.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const result = await encryptedCache.getMany('s1', ['pozzy.cache.s1.a', 'pozzy.cache.s1.b']);
    expect(result.values.size).toBe(0);
    expect(result.unreadable.sort()).toEqual(['pozzy.cache.s1.a', 'pozzy.cache.s1.b']);
  });

  it('clearServer удаляет кэш и ключ данных только этого сервера', async () => {
    await encryptedCache.set('s1', 'pozzy.cache.s1.a', '1');
    await encryptedCache.set('s2', 'pozzy.cache.s2.a', '2');
    await encryptedCache.clearServer('s1');
    expect(rawAsyncStorage()['pozzy.cache.s1.a']).toBeUndefined();
    expect(secureStoreMock.__store.has(secretKeys.serverDataKey('s1'))).toBe(false);
    expect(await encryptedCache.get('s2', 'pozzy.cache.s2.a')).toBe('2');
  });

  it('ключ данных недоступен → запись падает, legacy-значение остаётся на месте', async () => {
    await AsyncStorage.setItem('pozzy.templates.v1', 'legacy');
    secureStoreMock.__failNext('set', 10);
    expect(await encryptedCache.encryptInPlace(APP_SCOPE, ['pozzy.templates.v1'])).toBe(false);
    expect(rawAsyncStorage()['pozzy.templates.v1']).toBe('legacy');
    secureStoreMock.__failNext('set', 0);
    expect(await encryptedCache.encryptInPlace(APP_SCOPE, ['pozzy.templates.v1'])).toBe(true);
    expect(rawAsyncStorage()['pozzy.templates.v1'].startsWith('enc:v1:')).toBe(true);
  });
});
