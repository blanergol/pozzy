import AsyncStorage from '@react-native-async-storage/async-storage';
import { migrateLegacyAttachmentFiles } from '../../data/attachmentQueue';
import { CHAT_HISTORY_KEY, CHAT_SUMMARY_KEY } from '../chatHistory';
import { migrateOfflineProfile } from '../offlineStore';
import {
  listStoredProfileIds,
  migrateAISecret,
  migrateLegacySingleServer,
  migrateServerSecrets,
} from '../settings';
import { TEMPLATES_KEY } from '../templates';
import { APP_SCOPE, encryptedCache } from './encryptedCache';
import { cleanupPlaintextTempFiles, sweepLegacyAttachmentFiles } from './encryptedFiles';
import { secrets } from './secrets';

/**
 * Однократная миграция хранилища при старте — до загрузки настроек и до
 * любого синка. Каждый шаг идемпотентен и безопасен к прерыванию: открытый
 * текст удаляется только после проверенной записи нового представления.
 * Флаг версии ставится, только когда все шаги прошли; иначе миграция
 * повторится при следующем запуске.
 */

export const MIGRATION_KEY = 'pozzy.migration.v1';
export const INSTALL_MARKER_KEY = 'pozzy.installed.v1';
const MIGRATION_VERSION = '1';

const LEGACY_OFFLINE_PATTERN = /^poznote\.offline\.(.+)\.v1$/;
const APP_SCOPE_KEYS = [CHAT_HISTORY_KEY, CHAT_SUMMARY_KEY, TEMPLATES_KEY];

/**
 * Чистая установка: маркера нет И в AsyncStorage нет данных приложения.
 * На iOS Keychain переживает удаление приложения — удаляем всё, что записала
 * прошлая установка. Второе условие страхует от потери секретов, если запись
 * маркера когда-то не удалась: при наличии данных это обновление или обычный
 * запуск, и секреты трогать нельзя. Маркер ставится ДО переноса секретов.
 */
async function handleFreshInstall(): Promise<void> {
  if ((await AsyncStorage.getItem(INSTALL_MARKER_KEY)) !== null) return;
  const keys = await AsyncStorage.getAllKeys();
  const hasAppData = keys.some((k) => k.startsWith('poznote.') || k.startsWith('pozzy.'));
  if (!hasAppData) await secrets.deleteAll();
  await AsyncStorage.setItem(INSTALL_MARKER_KEY, '1');
}

async function migrateOfflineCaches(): Promise<boolean> {
  const ids = new Set(await listStoredProfileIds());
  for (const key of await AsyncStorage.getAllKeys()) {
    const match = LEGACY_OFFLINE_PATTERN.exec(key);
    if (match) ids.add(match[1]);
  }
  let ok = true;
  const referenced = new Set<string>();
  for (const id of ids) {
    // Очередь переносится первой и с проверкой (см. offlineStore.convertLegacy)
    if (!(await migrateOfflineProfile(id))) {
      ok = false;
      continue;
    }
    // Возвращаются только существующие legacy-файлы, которые не удалось
    // зашифровать; операции с уже пропавшим файлом флаг миграции не блокируют
    for (const uri of await migrateLegacyAttachmentFiles(id)) referenced.add(uri);
  }
  if (referenced.size > 0) ok = false;
  // Осиротевшие legacy-файлы удаляем, только когда все очереди прочитаны
  if (ok) await sweepLegacyAttachmentFiles(referenced).catch(() => {});
  return ok;
}

async function migrateAppScope(): Promise<boolean> {
  if (encryptedCache.persistent) {
    return encryptedCache.encryptInPlace(APP_SCOPE, APP_SCOPE_KEYS);
  }
  // Web: история чата живёт в памяти сессии — переносим её туда и удаляем из
  // localStorage. Шаблоны на web остаются в localStorage (см. durableAppValues).
  for (const key of [CHAT_HISTORY_KEY, CHAT_SUMMARY_KEY]) {
    const raw = await AsyncStorage.getItem(key);
    if (raw === null) continue;
    await encryptedCache.set(APP_SCOPE, key, raw);
    await AsyncStorage.removeItem(key);
  }
  return true;
}

async function step(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  await handleFreshInstall().catch(() => {});
  await cleanupPlaintextTempFiles().catch(() => {});
  if ((await AsyncStorage.getItem(MIGRATION_KEY).catch(() => null)) === MIGRATION_VERSION) return;

  let ok = await step(async () => {
    await migrateLegacySingleServer();
    return true;
  });
  // Порядок: сначала данные пользователя (очередь несинхронизированных правок),
  // затем секреты, затем общие данные приложения.
  ok = (await step(migrateOfflineCaches)) && ok;
  ok = (await step(migrateServerSecrets)) && ok;
  ok = (await step(migrateAISecret)) && ok;
  ok = (await step(migrateAppScope)) && ok;

  if (ok) await AsyncStorage.setItem(MIGRATION_KEY, MIGRATION_VERSION).catch(() => {});
}

let running: Promise<void> | null = null;

/** Запустить миграцию (повторные вызовы в той же сессии ждут первый). Не бросает. */
export function runStartupMigration(): Promise<void> {
  if (!running) running = run().catch(() => {});
  return running;
}

/** Только для тестов: разрешить повторный запуск в той же сессии. */
export function __resetMigrationForTests(): void {
  running = null;
}
