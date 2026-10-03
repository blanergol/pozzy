import AsyncStorage from '@react-native-async-storage/async-storage';
import { ServerSettings } from '../api/client';
import { ThemeMode } from '../theme/ThemeContext';
import { LanguageMode } from '../i18n';
import { secretKeys, secrets } from './secure/secrets';

/** Saved server connection profile. */
export interface ServerProfile extends ServerSettings {
  id: string;
}

interface ServersStorage {
  servers: ServerProfile[];
  activeId: string | null;
}

/*
 * Profile passwords and the AI API key live only in SecureStore (see secure/secrets).
 * AsyncStorage holds the non-secret fields: address, login, userId, UI settings.
 */

export const SERVERS_KEY = 'poznote.servers.v1';
const THEME_MODE_KEY = 'poznote.themeMode.v1';
const LANGUAGE_MODE_KEY = 'poznote.languageMode.v1';
const WORKSPACE_KEY = 'poznote.selectedWorkspace.v1';
export const AI_SETTINGS_KEY = 'poznote.aiSettings.v1';
export const ONBOARDING_KEY = 'poznote.onboarding.v1';
// legacy format of the first app version (single server)
export const LEGACY_SETTINGS_KEY = 'poznote.serverSettings.v1';

function makeId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Profile as it is stored in AsyncStorage (legacy — with the password). */
type StoredProfile = Omit<ServerProfile, 'password'> & { password?: string };

async function readServersRaw(): Promise<{ servers: StoredProfile[]; activeId: string | null } | null> {
  const raw = await AsyncStorage.getItem(SERVERS_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { servers?: unknown; activeId?: string | null };
  if (!Array.isArray(parsed.servers)) return null;
  return {
    servers: parsed.servers.filter(
      (p): p is StoredProfile => !!p && typeof (p as StoredProfile).id === 'string',
    ),
    activeId: parsed.activeId ?? null,
  };
}

function stripPassword(profile: StoredProfile): StoredProfile {
  const { password: _password, ...rest } = profile;
  return rest;
}

/** ids of all profiles from AsyncStorage (for cache migration). */
export async function listStoredProfileIds(): Promise<string[]> {
  try {
    return ((await readServersRaw())?.servers ?? []).map((p) => p.id);
  } catch {
    return [];
  }
}

/**
 * Legacy first-version format (single server) → list of profiles. The password
 * is carried into the list as is; migrateServerSecrets then moves it to
 * SecureStore (write → verify → remove from JSON).
 */
export async function migrateLegacySingleServer(): Promise<void> {
  const raw = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
  if (!raw) return;
  let parsed: ServerSettings | null = null;
  try {
    parsed = JSON.parse(raw) as ServerSettings;
  } catch {
    parsed = null;
  }
  if (parsed && parsed.baseUrl && parsed.username) {
    let existing = null;
    try {
      existing = await readServersRaw();
    } catch {
      existing = null;
    }
    if (!existing) {
      const profile: ServerProfile = { ...parsed, id: makeId() };
      await AsyncStorage.setItem(
        SERVERS_KEY,
        JSON.stringify({ servers: [profile], activeId: profile.id }),
      );
    }
  }
  await AsyncStorage.removeItem(LEGACY_SETTINGS_KEY);
}

/**
 * Move profile passwords to SecureStore: write → read back and compare →
 * only then remove from JSON. Interruption is safe: while the password is in JSON,
 * it remains the source and is migrated again on the next launch.
 * true = no passwords are left in AsyncStorage.
 */
export async function migrateServerSecrets(): Promise<boolean> {
  let stored;
  try {
    stored = await readServersRaw();
  } catch {
    return false;
  }
  if (!stored) return true;
  const migrated = new Set<string>();
  let remaining = 0;
  for (const profile of stored.servers) {
    if (!('password' in profile)) continue;
    const password = profile.password;
    if (
      typeof password !== 'string' ||
      password === '' ||
      (await secrets.setVerified(secretKeys.serverPassword(profile.id), password))
    ) {
      migrated.add(profile.id);
    } else {
      remaining++;
    }
  }
  if (migrated.size > 0) {
    const servers = stored.servers.map((p) => (migrated.has(p.id) ? stripPassword(p) : p));
    await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify({ servers, activeId: stored.activeId }));
  }
  return remaining === 0;
}

export async function loadServers(): Promise<ServersStorage> {
  try {
    const stored = await readServersRaw();
    if (stored) {
      const servers = await Promise.all(
        stored.servers.map(async (p): Promise<ServerProfile> => {
          const secret = await secrets.get(secretKeys.serverPassword(p.id));
          // Unfinished migration: the password is still in JSON — use it
          const password = secret ?? (typeof p.password === 'string' ? p.password : '');
          return { ...p, password };
        }),
      );
      return { servers, activeId: stored.activeId };
    }
  } catch {
    // fallthrough
  }
  return { servers: [], activeId: null };
}

// Profile list writes and secret removals go through a single chain: otherwise
// an earlier saveServers that finished later would bring back a removed profile
// or write its password again.
let serversChain: Promise<unknown> = Promise.resolve();
const removedServers = new Set<string>();

function enqueueServers<T>(fn: () => Promise<T>): Promise<T> {
  const next = serversChain.then(fn, fn);
  serversChain = next.catch(() => {});
  return next;
}

/**
 * Save the profile list: passwords go to SecureStore, AsyncStorage gets only the
 * non-secret fields. An empty password does NOT delete the secret: it means "could
 * not read" (or web after a reload), not "the user cleared the password" — the form
 * doesn't allow saving a profile without a password. Only removeServerSecrets
 * deletes secrets. If SecureStore is unavailable, the profile is still saved,
 * but the password never ends up in AsyncStorage.
 */
export function saveServers(storage: ServersStorage): Promise<void> {
  return enqueueServers(async () => {
    let secretError: unknown = null;
    for (const profile of storage.servers) {
      if (!profile.password || removedServers.has(profile.id)) continue;
      const key = secretKeys.serverPassword(profile.id);
      try {
        if ((await secrets.get(key)) !== profile.password) await secrets.set(key, profile.password);
      } catch (e) {
        secretError = e;
      }
    }
    const servers = storage.servers.filter((p) => !removedServers.has(p.id)).map(stripPassword);
    await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify({ servers, activeId: storage.activeId }));
    if (secretError) throw secretError;
  });
}

/** Delete the server's secrets (password, data key) — after all pending profile writes. */
export function removeServerSecrets(serverId: string): Promise<void> {
  removedServers.add(serverId);
  return enqueueServers(() => secrets.deleteServer(serverId));
}

/** null = all workspaces. */
export async function loadSelectedWorkspace(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(WORKSPACE_KEY);
  } catch {
    return null;
  }
}

export async function saveSelectedWorkspace(workspace: string | null): Promise<void> {
  if (workspace === null) {
    await AsyncStorage.removeItem(WORKSPACE_KEY);
  } else {
    await AsyncStorage.setItem(WORKSPACE_KEY, workspace);
  }
}

export async function clearWorkspace(): Promise<void> {
  await AsyncStorage.removeItem(WORKSPACE_KEY);
}

export async function loadThemeMode(): Promise<ThemeMode> {
  try {
    const raw = await AsyncStorage.getItem(THEME_MODE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // fallthrough
  }
  return 'system';
}

export async function saveThemeMode(mode: ThemeMode): Promise<void> {
  await AsyncStorage.setItem(THEME_MODE_KEY, mode);
}

export async function loadLanguageMode(): Promise<LanguageMode> {
  try {
    const raw = await AsyncStorage.getItem(LANGUAGE_MODE_KEY);
    if (raw === 'ru' || raw === 'en' || raw === 'system') return raw;
  } catch {
    // fallthrough
  }
  return 'system';
}

export async function saveLanguageMode(mode: LanguageMode): Promise<void> {
  await AsyncStorage.setItem(LANGUAGE_MODE_KEY, mode);
}

/** OpenAI-compatible API settings for the AI chat. */
export interface AISettings {
  /** false = all AI functionality is hidden (the chat tab and settings). */
  enabled: boolean;
  baseUrl: string;
  /** Stored in SecureStore, not in AsyncStorage. */
  apiKey: string;
  model: string;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

// The app has a single AI provider with no id
const AI_API_KEY = secretKeys.aiApiKey();
// The key could not be read: an empty apiKey in state doesn't mean "the user
// cleared the key", and saving other AI settings must not delete it.
let aiKeyUnreadable = false;

async function readAIKey(): Promise<string | null> {
  try {
    const value = await secrets.read(AI_API_KEY);
    aiKeyUnreadable = false;
    return value;
  } catch {
    aiKeyUnreadable = true;
    return null;
  }
}

export async function loadAISettings(): Promise<AISettings> {
  try {
    const raw = await AsyncStorage.getItem(AI_SETTINGS_KEY);
    const secret = await readAIKey();
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AISettings>;
      // Unfinished migration: the key is still in JSON — use it
      const legacyKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : '';
      return {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
        baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl ? parsed.baseUrl : DEFAULT_AI_SETTINGS.baseUrl,
        apiKey: secret ?? legacyKey,
        model: typeof parsed.model === 'string' && parsed.model ? parsed.model : DEFAULT_AI_SETTINGS.model,
      };
    }
    if (secret) return { ...DEFAULT_AI_SETTINGS, apiKey: secret };
  } catch {
    // fallthrough
  }
  return DEFAULT_AI_SETTINGS;
}

export async function saveAISettings(settings: AISettings): Promise<void> {
  const { apiKey, ...rest } = settings;
  let secretError: unknown = null;
  try {
    if (apiKey) {
      await secrets.set(AI_API_KEY, apiKey);
      aiKeyUnreadable = false;
    } else if (!aiKeyUnreadable) {
      await secrets.delete(AI_API_KEY);
    }
  } catch (e) {
    secretError = e;
  }
  await AsyncStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(rest));
  if (secretError) throw secretError;
}

/** Move the AI API key to SecureStore (write → verify → remove from JSON). */
export async function migrateAISecret(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(AI_SETTINGS_KEY);
  if (!raw) return true;
  let parsed: Partial<AISettings>;
  try {
    parsed = JSON.parse(raw) as Partial<AISettings>;
  } catch {
    // unreadable JSON yielded the default settings before too
    await AsyncStorage.removeItem(AI_SETTINGS_KEY);
    return true;
  }
  if (!parsed || typeof parsed !== 'object' || !('apiKey' in parsed)) return true;
  const { apiKey, ...rest } = parsed;
  if (typeof apiKey === 'string' && apiKey !== '') {
    if (!(await secrets.setVerified(AI_API_KEY, apiKey))) return false;
  }
  await AsyncStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(rest));
  return true;
}

/** Onboarding is shown once — the "already seen" flag. */
export async function loadOnboardingSeen(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ONBOARDING_KEY)) === '1';
  } catch {
    return false;
  }
}

export async function saveOnboardingSeen(): Promise<void> {
  await AsyncStorage.setItem(ONBOARDING_KEY, '1');
}
