import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { legacyOfflineKey, loadOfflineData, saveOfflineData } from '../../offlineStore';
import { loadServers, saveServers } from '../../settings';
import { loadChatHistory } from '../../chatHistory';
import { loadTemplates } from '../../templates';
import { runStartupMigration } from '../migration';
import { rawAsyncStorage, restartApp, secureStoreMock, wipeDevice } from '../../../../test/secureTestUtils';

// Эмуляция web-сборки: Metro подставил бы *.web.ts
jest.mock('../secretBackend', () => jest.requireActual('../secretBackend.web'));
jest.mock('../cacheBackend', () => jest.requireActual('../cacheBackend.web'));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const P = 'web-prof';

describe('web: секреты в памяти, кэш на сессию', () => {
  beforeEach(async () => {
    await wipeDevice();
  });

  it('пароль не пишется ни в localStorage, ни в SecureStore', async () => {
    await saveServers({
      servers: [{ id: P, baseUrl: 'https://x', username: 'u', password: 'WEB-SECRET', userId: '' }],
      activeId: P,
    });
    expect(JSON.stringify(rawAsyncStorage())).not.toContain('WEB-SECRET');
    expect(secureStoreMock.__store.size).toBe(0);
    expect((await loadServers()).servers[0].password).toBe('WEB-SECRET');
  });

  it('миграция убирает секреты и чат из localStorage, шаблоны оставляет', async () => {
    await AsyncStorage.setItem(
      'poznote.servers.v1',
      JSON.stringify({ servers: [{ id: P, baseUrl: 'https://x', username: 'u', password: 'WEB-SECRET', userId: '' }], activeId: P }),
    );
    await AsyncStorage.setItem('poznote.chatHistory.v1', JSON.stringify([{ id: '1', role: 'user', content: 'CHAT' }]));
    await AsyncStorage.setItem('pozzy.templates.v1', JSON.stringify([{ id: 't', name: 'n', heading: 'h', content: 'TPL' }]));
    await runStartupMigration();
    expect(JSON.stringify(rawAsyncStorage())).not.toContain('WEB-SECRET');
    expect(rawAsyncStorage()['poznote.chatHistory.v1']).toBeUndefined();
    // шаблоны на web остаются в localStorage и переживают перезагрузку
    expect(rawAsyncStorage()['pozzy.templates.v1']).toContain('TPL');
    restartApp();
    expect((await loadTemplates())[0].content).toBe('TPL');
    // в рамках сессии всё доступно
    expect((await loadServers()).servers[0].password).toBe('WEB-SECRET');
    expect((await loadChatHistory())[0].content).toBe('CHAT');
  });

  it('несинхронизированные legacy-правки не теряются при перезагрузке, пока не уйдут на сервер', async () => {
    await AsyncStorage.setItem(
      legacyOfflineKey(P),
      JSON.stringify({
        notesDetails: { '1': { id: 1, content: 'CACHED-NOTE' } },
        pending: [{ opId: 'u1', type: 'update', noteId: 1, payload: { content: 'EDIT' }, clientTs: 'x' }],
      }),
    );
    const data = await loadOfflineData(P);
    expect(data.pending).toHaveLength(1);
    // кэш заметок ушёл из localStorage, legacy-операция осталась до синка
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).not.toContain('CACHED-NOTE');
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toContain('EDIT');

    // новая правка в этой сессии в localStorage не попадает
    data.pending.push({ opId: 'n1', type: 'update', noteId: 2, payload: { content: 'NEW-SESSION-EDIT' }, clientTs: 'y' });
    await saveOfflineData(P, data);
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).not.toContain('NEW-SESSION-EDIT');

    // «перезагрузка страницы» до синка: legacy-правка на месте
    restartApp();
    const reloaded = await loadOfflineData(P);
    expect(reloaded.pending.map((op) => op.opId)).toEqual(['u1']);

    // синк отправил операцию — legacy-ключ удаляется
    reloaded.pending = [];
    await saveOfflineData(P, reloaded);
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toBeUndefined();
  });
});
