import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { legacyOfflineKey, loadOfflineData, saveOfflineData } from '../../offlineStore';
import { loadServers, saveServers } from '../../settings';
import { loadChatHistory } from '../../chatHistory';
import { loadTemplates } from '../../templates';
import { runStartupMigration } from '../migration';
import { rawAsyncStorage, restartApp, secureStoreMock, wipeDevice } from '../../../../test/secureTestUtils';

// Emulating the web build: Metro would substitute *.web.ts
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
    // templates on web stay in localStorage and survive a reload
    expect(rawAsyncStorage()['pozzy.templates.v1']).toContain('TPL');
    restartApp();
    expect((await loadTemplates())[0].content).toBe('TPL');
    // within the session everything is available
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
    // the notes cache is gone from localStorage, the legacy operation stays until sync
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).not.toContain('CACHED-NOTE');
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toContain('EDIT');

    // a new edit in this session doesn't go to localStorage
    data.pending.push({ opId: 'n1', type: 'update', noteId: 2, payload: { content: 'NEW-SESSION-EDIT' }, clientTs: 'y' });
    await saveOfflineData(P, data);
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).not.toContain('NEW-SESSION-EDIT');

    // "page reload" before sync: the legacy edit is still there
    restartApp();
    const reloaded = await loadOfflineData(P);
    expect(reloaded.pending.map((op) => op.opId)).toEqual(['u1']);

    // sync sent the operation — the legacy key is deleted
    reloaded.pending = [];
    await saveOfflineData(P, reloaded);
    expect(rawAsyncStorage()[legacyOfflineKey(P)]).toBeUndefined();
  });
});
