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
 * One-time storage migration at startup — before settings are loaded and before
 * any sync. Each step is idempotent and safe to interrupt: plaintext is deleted
 * only after the new representation has been written and verified.
 * The version flag is set only when all steps succeeded; otherwise the migration
 * is repeated on the next launch.
 */

export const MIGRATION_KEY = 'pozzy.migration.v1';
export const INSTALL_MARKER_KEY = 'pozzy.installed.v1';
const MIGRATION_VERSION = '1';

const LEGACY_OFFLINE_PATTERN = /^poznote\.offline\.(.+)\.v1$/;
const APP_SCOPE_KEYS = [CHAT_HISTORY_KEY, CHAT_SUMMARY_KEY, TEMPLATES_KEY];

/**
 * Fresh install: no marker AND no app data in AsyncStorage.
 * On iOS the Keychain survives app uninstall — delete everything the previous
 * install wrote. The second condition guards against losing secrets if writing
 * the marker once failed: when data is present this is an update or a regular
 * launch, and secrets must not be touched. The marker is set BEFORE secrets are moved.
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
    // The queue is moved first and with verification (see offlineStore.convertLegacy)
    if (!(await migrateOfflineProfile(id))) {
      ok = false;
      continue;
    }
    // Only existing legacy files that could not be encrypted are returned;
    // operations whose file is already gone don't block the migration flag
    for (const uri of await migrateLegacyAttachmentFiles(id)) referenced.add(uri);
  }
  if (referenced.size > 0) ok = false;
  // Orphaned legacy files are deleted only once all queues have been read
  if (ok) await sweepLegacyAttachmentFiles(referenced).catch(() => {});
  return ok;
}

async function migrateAppScope(): Promise<boolean> {
  if (encryptedCache.persistent) {
    return encryptedCache.encryptInPlace(APP_SCOPE, APP_SCOPE_KEYS);
  }
  // Web: chat history lives in session memory — move it there and remove it from
  // localStorage. Templates on web stay in localStorage (see durableAppValues).
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
  // Order: user data first (the queue of unsynced edits),
  // then secrets, then app-wide data.
  ok = (await step(migrateOfflineCaches)) && ok;
  ok = (await step(migrateServerSecrets)) && ok;
  ok = (await step(migrateAISecret)) && ok;
  ok = (await step(migrateAppScope)) && ok;

  if (ok) await AsyncStorage.setItem(MIGRATION_KEY, MIGRATION_VERSION).catch(() => {});
}

let running: Promise<void> | null = null;

/** Run the migration (repeated calls in the same session wait for the first). Never throws. */
export function runStartupMigration(): Promise<void> {
  if (!running) running = run().catch(() => {});
  return running;
}

/** Tests only: allow re-running in the same session. */
export function __resetMigrationForTests(): void {
  running = null;
}
