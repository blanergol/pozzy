import AsyncStorage from '@react-native-async-storage/async-storage';
import { ServerSettings } from '../api/client';
import { ThemeMode } from '../theme/ThemeContext';
import { LanguageMode } from '../i18n';
import { secretKeys, secrets } from './secure/secrets';

/** Сохранённый профиль подключения к серверу. */
export interface ServerProfile extends ServerSettings {
  id: string;
}

interface ServersStorage {
  servers: ServerProfile[];
  activeId: string | null;
}

/*
 * Пароли профилей и API-ключ AI живут только в SecureStore (см. secure/secrets).
 * В AsyncStorage — несекретные поля: адрес, логин, userId, настройки UI.
 */

export const SERVERS_KEY = 'poznote.servers.v1';
const THEME_MODE_KEY = 'poznote.themeMode.v1';
const LANGUAGE_MODE_KEY = 'poznote.languageMode.v1';
const WORKSPACE_KEY = 'poznote.selectedWorkspace.v1';
export const AI_SETTINGS_KEY = 'poznote.aiSettings.v1';
export const ONBOARDING_KEY = 'poznote.onboarding.v1';
// legacy формат первой версии приложения (один сервер)
export const LEGACY_SETTINGS_KEY = 'poznote.serverSettings.v1';

function makeId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Профиль в том виде, как он лежит в AsyncStorage (legacy — с паролем). */
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

/** id всех профилей из AsyncStorage (для миграции кэша). */
export async function listStoredProfileIds(): Promise<string[]> {
  try {
    return ((await readServersRaw())?.servers ?? []).map((p) => p.id);
  } catch {
    return [];
  }
}

/**
 * Legacy-формат первой версии (один сервер) → список профилей. Пароль
 * переносится в список как есть; в SecureStore его затем переносит
 * migrateServerSecrets (запись → проверка → удаление из JSON).
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
 * Перенос паролей профилей в SecureStore: записать → прочитать и сравнить →
 * только потом убрать из JSON. Прерывание безопасно: пока пароль в JSON, он
 * остаётся источником и переносится заново при следующем запуске.
 * true = в AsyncStorage не осталось ни одного пароля.
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
          // Незавершённая миграция: пароль ещё в JSON — используем его
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

// Записи списка профилей и удаление секретов идут по одной цепочке: иначе
// более ранний saveServers, закончившийся позже, вернул бы удалённый профиль
// или заново записал его пароль.
let serversChain: Promise<unknown> = Promise.resolve();
const removedServers = new Set<string>();

function enqueueServers<T>(fn: () => Promise<T>): Promise<T> {
  const next = serversChain.then(fn, fn);
  serversChain = next.catch(() => {});
  return next;
}

/**
 * Сохранить список профилей: пароли — в SecureStore, в AsyncStorage — только
 * несекретные поля. Пустой пароль секрет НЕ удаляет: он означает «не удалось
 * прочитать» (или web после перезагрузки), а не «пользователь стёр пароль» —
 * форма не даёт сохранить профиль без пароля. Удаляет секреты только
 * removeServerSecrets. Если SecureStore недоступен, профиль всё равно
 * сохраняется, но пароль никогда не попадает в AsyncStorage.
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

/** Удалить секреты сервера (пароль, ключ данных) — после всех ожидающих записей профилей. */
export function removeServerSecrets(serverId: string): Promise<void> {
  removedServers.add(serverId);
  return enqueueServers(() => secrets.deleteServer(serverId));
}

/** null = все пространства. */
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

/** Настройки OpenAI-совместимого API для AI-чата. */
export interface AISettings {
  /** false = весь AI-функционал скрыт (вкладка чата и настройки). */
  enabled: boolean;
  baseUrl: string;
  /** Хранится в SecureStore, не в AsyncStorage. */
  apiKey: string;
  model: string;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: true,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
};

// Провайдер AI в приложении один и без id
const AI_API_KEY = secretKeys.aiApiKey();
// Ключ не удалось прочитать: пустое apiKey в состоянии не значит «пользователь
// стёр ключ», и сохранение других настроек AI не должно его удалять.
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
      // Незавершённая миграция: ключ ещё в JSON — используем его
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

/** Перенос API-ключа AI в SecureStore (запись → проверка → удаление из JSON). */
export async function migrateAISecret(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(AI_SETTINGS_KEY);
  if (!raw) return true;
  let parsed: Partial<AISettings>;
  try {
    parsed = JSON.parse(raw) as Partial<AISettings>;
  } catch {
    // нечитаемый JSON и раньше давал настройки по умолчанию
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

/** Онбординг показывается один раз — флаг «уже видели». */
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
