import AsyncStorage from '@react-native-async-storage/async-storage';
import { ServerSettings } from '../api/client';
import { ThemeMode } from '../theme/ThemeContext';
import { LanguageMode } from '../i18n';

/** Сохранённый профиль подключения к серверу. */
export interface ServerProfile extends ServerSettings {
  id: string;
}

interface ServersStorage {
  servers: ServerProfile[];
  activeId: string | null;
}

const SERVERS_KEY = 'poznote.servers.v1';
const THEME_MODE_KEY = 'poznote.themeMode.v1';
const LANGUAGE_MODE_KEY = 'poznote.languageMode.v1';
const WORKSPACE_KEY = 'poznote.selectedWorkspace.v1';
// legacy формат первой версии приложения (один сервер)
const LEGACY_SETTINGS_KEY = 'poznote.serverSettings.v1';

function makeId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function migrateLegacy(): Promise<ServersStorage | null> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ServerSettings;
    if (!parsed.baseUrl || !parsed.username) return null;
    const profile: ServerProfile = { ...parsed, id: makeId() };
    const storage: ServersStorage = { servers: [profile], activeId: profile.id };
    await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(storage));
    await AsyncStorage.removeItem(LEGACY_SETTINGS_KEY);
    return storage;
  } catch {
    return null;
  }
}

export async function loadServers(): Promise<ServersStorage> {
  try {
    const raw = await AsyncStorage.getItem(SERVERS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ServersStorage;
      if (Array.isArray(parsed.servers)) {
        return { servers: parsed.servers, activeId: parsed.activeId ?? null };
      }
    }
    const migrated = await migrateLegacy();
    if (migrated) return migrated;
  } catch {
    // fallthrough
  }
  return { servers: [], activeId: null };
}

export async function saveServers(storage: ServersStorage): Promise<void> {
  await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(storage));
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
