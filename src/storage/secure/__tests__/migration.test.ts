import AsyncStorage from '@react-native-async-storage/async-storage';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { loadChatHistory, loadChatSummary } from '../../chatHistory';
import { loadOfflineData } from '../../offlineStore';
import { loadAISettings, loadServers } from '../../settings';
import { loadTemplates } from '../../templates';
import { takeLostEdits } from '../lostData';
import { INSTALL_MARKER_KEY, MIGRATION_KEY, runStartupMigration } from '../migration';
import { secretKeys } from '../secrets';
import {
  crashAfter,
  operationCount,
  rawAsyncStorage,
  restartApp,
  secureStoreMock,
  stopCrashing,
  wipeDevice,
} from '../../../../test/secureTestUtils';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const P1 = 'mh1abc-x1y2z3';
const P2 = 'mh2def-q7w8e9';

const SENSITIVE = [
  'S3CRET-PASS',
  'OTHER-PASS',
  'sk-SECRET-KEY',
  'HEADING-SECRET',
  'NOTE-SECRET',
  'UNSYNCED-CREATE',
  'UNSYNCED-EDIT',
  'CHAT-SECRET',
  'SUMMARY-SECRET',
  'TPL-SECRET',
];

function listItem(id: number, heading: string) {
  return {
    id,
    heading,
    type: 'note',
    tags: null,
    folder: null,
    folder_id: null,
    workspace: null,
    updated: '2026-01-01 10:00:00',
    created: '2026-01-01 10:00:00',
    favorite: 0,
    icon: null,
    icon_color: null,
    color: null,
    color_hex: null,
  };
}

/** AsyncStorage state of the previous release (1.0.7): everything in plaintext. */
async function seedPreviousRelease(): Promise<void> {
  await AsyncStorage.multiSet([
    [
      'poznote.servers.v1',
      JSON.stringify({
        servers: [
          { id: P1, baseUrl: 'https://notes.example', username: 'alice', password: 'S3CRET-PASS', userId: '1' },
          { id: P2, baseUrl: 'https://other.example', username: 'bob', password: 'OTHER-PASS', userId: '' },
        ],
        activeId: P1,
      }),
    ],
    [
      'poznote.aiSettings.v1',
      JSON.stringify({ enabled: true, baseUrl: 'https://api.example/v1', apiKey: 'sk-SECRET-KEY', model: 'm' }),
    ],
    [
      `poznote.offline.${P1}.v1`,
      JSON.stringify({
        notesList: [listItem(1, 'HEADING-SECRET'), listItem(-1, 'offline')],
        notesDetails: {
          '1': { ...listItem(1, 'HEADING-SECRET'), content: 'NOTE-SECRET', linked_note_id: null, reminder_at: null },
        },
        folders: [],
        pending: [
          { opId: 'c1', type: 'create', noteId: -1, payload: { heading: 'offline', content: 'UNSYNCED-CREATE' }, clientTs: '2026-01-02T00:00:00.000Z' },
          { opId: 'u1', type: 'update', noteId: 1, payload: { content: 'UNSYNCED-EDIT' }, clientTs: '2026-01-03T00:00:00.000Z' },
        ],
        aliases: {},
      }),
    ],
    ['poznote.chatHistory.v1', JSON.stringify([{ id: 'm1', role: 'user', content: 'CHAT-SECRET' }])],
    ['poznote.chatSummary.v1', JSON.stringify({ summary: 'SUMMARY-SECRET', coveredCount: 1 })],
    ['pozzy.templates.v1', JSON.stringify([{ id: 't1', name: 'T', heading: 'h', content: 'TPL-SECRET' }])],
    ['poznote.onboarding.v1', '1'],
    ['poznote.themeMode.v1', 'dark'],
  ]);
}

async function expectFullyMigrated(): Promise<void> {
  const disk = JSON.stringify(rawAsyncStorage());
  for (const secret of SENSITIVE) expect(disk).not.toContain(secret);
  expect(rawAsyncStorage()[MIGRATION_KEY]).toBe('1');
  expect(rawAsyncStorage()[`poznote.offline.${P1}.v1`]).toBeUndefined();

  restartApp();
  await runStartupMigration();
  const { servers, activeId } = await loadServers();
  expect(activeId).toBe(P1);
  expect(servers.map((s) => [s.id, s.username, s.password])).toEqual([
    [P1, 'alice', 'S3CRET-PASS'],
    [P2, 'bob', 'OTHER-PASS'],
  ]);
  expect((await loadAISettings()).apiKey).toBe('sk-SECRET-KEY');

  const data = await loadOfflineData(P1);
  expect(data.pending.map((op) => [op.opId, op.payload.content])).toEqual([
    ['c1', 'UNSYNCED-CREATE'],
    ['u1', 'UNSYNCED-EDIT'],
  ]);
  expect(data.notesDetails['1'].content).toBe('NOTE-SECRET');
  expect(data.notesList.map((n) => n.heading)).toEqual(['HEADING-SECRET', 'offline']);

  expect((await loadChatHistory()).map((m) => m.content)).toEqual(['CHAT-SECRET']);
  expect((await loadChatSummary()).summary).toBe('SUMMARY-SECRET');
  expect((await loadTemplates()).map((t) => t.content)).toEqual(['TPL-SECRET']);
  // non-secret settings stay in AsyncStorage as they were
  expect(rawAsyncStorage()['poznote.themeMode.v1']).toBe('dark');
}

describe('startup migration', () => {
  beforeEach(async () => {
    await wipeDevice();
  });

  it('обновление с прошлого релиза: секреты в SecureStore, кэш зашифрован, ничего не потеряно', async () => {
    await seedPreviousRelease();
    await runStartupMigration();
    expect(secureStoreMock.__store.get(secretKeys.serverPassword(P1))).toBe('S3CRET-PASS');
    expect(secureStoreMock.__store.get(secretKeys.aiApiKey())).toBe('sk-SECRET-KEY');
    expect(secureStoreMock.__store.has(secretKeys.serverDataKey(P1))).toBe(true);
    await expectFullyMigrated();
  });

  it('legacy-формат первой версии (один сервер) тоже переносится', async () => {
    await AsyncStorage.setItem(
      'poznote.serverSettings.v1',
      JSON.stringify({ baseUrl: 'https://one.example', username: 'u', password: 'S3CRET-PASS', userId: '' }),
    );
    await runStartupMigration();
    expect(JSON.stringify(rawAsyncStorage())).not.toContain('S3CRET-PASS');
    restartApp();
    const { servers } = await loadServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].password).toBe('S3CRET-PASS');
  });

  it('идемпотентна: повторный запуск (в т.ч. без флага) ничего не меняет и не дублирует', async () => {
    await seedPreviousRelease();
    await runStartupMigration();
    restartApp();
    await runStartupMigration();
    await AsyncStorage.removeItem(MIGRATION_KEY);
    restartApp();
    await runStartupMigration();
    await expectFullyMigrated();
  });

  it('прерывание на любой операции хранилища безопасно и возобновляется', async () => {
    await seedPreviousRelease();
    crashAfter(Number.MAX_SAFE_INTEGER);
    await runStartupMigration();
    const total = operationCount();
    stopCrashing();
    expect(total).toBeGreaterThan(20);

    let crashes = 0;
    for (let k = 0; k < total; k++) {
      await wipeDevice();
      await seedPreviousRelease();
      crashAfter(k);
      await runStartupMigration(); // "the process dies" on the k-th operation
      stopCrashing();
      // the crash really did interrupt the migration: the flag is not set
      expect(rawAsyncStorage()[MIGRATION_KEY]).toBeUndefined();
      crashes++;
      restartApp();
      await runStartupMigration();
      try {
        await expectFullyMigrated();
      } catch (e) {
        throw new Error(`crash after operation ${k}/${total}: ${(e as Error).message}`);
      }
    }
    expect(crashes).toBe(total);
  });

  it('SecureStore не принимает запись: открытый текст не удаляется, флаг не ставится', async () => {
    await seedPreviousRelease();
    secureStoreMock.__failNext('set', 10_000);
    await runStartupMigration();
    expect(rawAsyncStorage()[MIGRATION_KEY]).toBeUndefined();
    expect(rawAsyncStorage()['poznote.servers.v1']).toContain('S3CRET-PASS');
    expect(rawAsyncStorage()[`poznote.offline.${P1}.v1`]).toContain('UNSYNCED-EDIT');
    // the app meanwhile keeps working on legacy data
    restartApp();
    expect((await loadServers()).servers[0].password).toBe('S3CRET-PASS');
    expect((await loadOfflineData(P1)).pending).toHaveLength(2);

    secureStoreMock.__failNext('set', 0);
    restartApp();
    await runStartupMigration();
    await expectFullyMigrated();
  });

  it('обратное чтение не совпало: legacy-пароль остаётся на месте', async () => {
    await seedPreviousRelease();
    secureStoreMock.__setCorruptReads(true);
    await runStartupMigration();
    expect(rawAsyncStorage()['poznote.servers.v1']).toContain('S3CRET-PASS');
    expect(rawAsyncStorage()[MIGRATION_KEY]).toBeUndefined();
    secureStoreMock.__setCorruptReads(false);
    restartApp();
    await runStartupMigration();
    await expectFullyMigrated();
  });

  it('восстановление из бэкапа без SecureStore: кэш стирается, пароли надо ввести, сообщение о правках', async () => {
    await seedPreviousRelease();
    await runStartupMigration();
    // Android Auto Backup: AsyncStorage restored, SecureStore excluded from the backup
    secureStoreMock.__reset();
    restartApp();
    await expect(runStartupMigration()).resolves.toBeUndefined();

    const { servers } = await loadServers();
    expect(servers.map((s) => s.password)).toEqual(['', '']);
    expect(servers.map((s) => s.username)).toEqual(['alice', 'bob']);
    expect((await loadAISettings()).apiKey).toBe('');
    const data = await loadOfflineData(P1);
    expect(data.pending).toEqual([]);
    expect(data.notesDetails).toEqual({});
    expect(await loadChatHistory()).toEqual([]);
    expect(await loadTemplates()).toEqual([]);
    expect(await takeLostEdits()).toEqual([P1]);
    expect(Object.keys(rawAsyncStorage()).some((k) => k.startsWith(`pozzy.cache.${P1}.`))).toBe(false);
  });

  it('чистая установка: остатки pozzy.* в Keychain от прошлой установки удаляются', async () => {
    // the previous install left entries in the Keychain (iOS doesn't clear it on uninstall)
    secureStoreMock.__store.set(secretKeys.serverPassword('old'), 'LEFTOVER');
    secureStoreMock.__store.set(secretKeys.serverDataKey('old'), 'LEFTOVER-KEY');
    secureStoreMock.__store.set(
      'pozzy.keys',
      JSON.stringify([secretKeys.serverPassword('old'), secretKeys.serverDataKey('old')]),
    );
    await runStartupMigration();
    expect(secureStoreMock.__store.size).toBe(0);
    expect(rawAsyncStorage()[INSTALL_MARKER_KEY]).toBe('1');
  });

  it('обычный перезапуск (маркер установки есть) секреты не трогает', async () => {
    await seedPreviousRelease();
    await runStartupMigration();
    const before = new Map(secureStoreMock.__store);
    restartApp();
    await runStartupMigration();
    expect(new Map(secureStoreMock.__store)).toEqual(before);
  });
});
