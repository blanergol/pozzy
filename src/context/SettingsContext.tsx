import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { PoznoteClient, ServerSettings } from '../api/client';
import { clearOfflineData } from '../storage/offlineStore';
import { ThemeMode, ThemeProvider } from '../theme/ThemeContext';
import { I18nProvider, LanguageMode } from '../i18n';
import {
  AISettings,
  clearWorkspace,
  DEFAULT_AI_SETTINGS,
  loadAISettings,
  loadLanguageMode,
  loadSelectedWorkspace,
  loadServers,
  loadThemeMode,
  saveAISettings,
  saveLanguageMode,
  saveSelectedWorkspace,
  saveServers,
  saveThemeMode,
  ServerProfile,
} from '../storage/settings';

interface SettingsContextValue {
  /** Все сохранённые серверы. */
  profiles: ServerProfile[];
  /** Активный сервер (текущее подключение). */
  activeProfile: ServerProfile | null;
  client: PoznoteClient | null;
  isLoading: boolean;
  /** Выбранное пространство; null = все пространства. */
  workspace: string | null;
  setWorkspace: (workspace: string | null) => void;
  /** Добавить новый сервер и сделать активным. Возвращает id профиля. */
  addProfile: (settings: ServerSettings) => Promise<string>;
  /** Обновить существующий профиль (без смены id). */
  updateProfile: (profile: ServerProfile) => Promise<void>;
  /** Удалить профиль. Если удалён активный — активным станет первый оставшийся. */
  removeProfile: (id: string) => Promise<void>;
  /** Переключиться на другой сервер. */
  switchProfile: (id: string) => Promise<void>;
  /** Режим темы. */
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  /** Язык интерфейса. */
  languageMode: LanguageMode;
  setLanguageMode: (mode: LanguageMode) => void;
  /** Настройки OpenAI-совместимого API для AI-чата. */
  aiSettings: AISettings;
  saveAiSettings: (settings: AISettings) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

function makeId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [profiles, setProfiles] = useState<ServerProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [workspace, setWorkspaceState] = useState<string | null>(null);
  const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
  const [languageMode, setLanguageModeState] = useState<LanguageMode>('system');
  const [aiSettings, setAiSettings] = useState<AISettings>(DEFAULT_AI_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    Promise.all([loadServers(), loadSelectedWorkspace(), loadThemeMode(), loadLanguageMode(), loadAISettings()])
      .then(([serversStorage, loadedWorkspace, loadedTheme, loadedLanguage, loadedAI]) => {
        setProfiles(serversStorage.servers);
        setActiveId(serversStorage.activeId);
        setWorkspaceState(loadedWorkspace);
        setThemeModeState(loadedTheme);
        setLanguageModeState(loadedLanguage);
        setAiSettings(loadedAI);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const persist = useCallback((nextProfiles: ServerProfile[], nextActiveId: string | null) => {
    setProfiles(nextProfiles);
    setActiveId(nextActiveId);
    saveServers({ servers: nextProfiles, activeId: nextActiveId }).catch(() => {});
  }, []);

  const addProfile = useCallback(
    async (settings: ServerSettings): Promise<string> => {
      const profile: ServerProfile = { ...settings, id: makeId() };
      persist([...profiles, profile], profile.id);
      return profile.id;
    },
    [profiles, persist],
  );

  const updateProfile = useCallback(
    async (profile: ServerProfile): Promise<void> => {
      persist(
        profiles.map((p) => (p.id === profile.id ? profile : p)),
        activeId,
      );
    },
    [profiles, activeId, persist],
  );

  const removeProfile = useCallback(
    async (id: string): Promise<void> => {
      const next = profiles.filter((p) => p.id !== id);
      const nextActive = activeId === id ? (next[0]?.id ?? null) : activeId;
      persist(next, nextActive);
      // оффлайн-кэш и очередь удалённого сервера больше не нужны
      clearOfflineData(id).catch(() => {});
    },
    [profiles, activeId, persist],
  );

  const switchProfile = useCallback(
    async (id: string): Promise<void> => {
      if (id === activeId) return;
      persist(profiles, id);
      // пространство привязано к серверу — сбрасываем фильтр
      setWorkspaceState(null);
      saveSelectedWorkspace(null).catch(() => {});
    },
    [profiles, activeId, persist],
  );

  const setWorkspace = useCallback((next: string | null) => {
    setWorkspaceState(next);
    saveSelectedWorkspace(next).catch(() => {});
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    saveThemeMode(mode).catch(() => {});
  }, []);

  const setLanguageMode = useCallback((mode: LanguageMode) => {
    setLanguageModeState(mode);
    saveLanguageMode(mode).catch(() => {});
  }, []);

  const saveAiSettings = useCallback((settings: AISettings) => {
    setAiSettings(settings);
    saveAISettings(settings).catch(() => {});
  }, []);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId) ?? null,
    [profiles, activeId],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      profiles,
      activeProfile,
      client: activeProfile ? new PoznoteClient(activeProfile) : null,
      isLoading,
      workspace,
      setWorkspace,
      addProfile,
      updateProfile,
      removeProfile,
      switchProfile,
      themeMode,
      setThemeMode,
      languageMode,
      setLanguageMode,
      aiSettings,
      saveAiSettings,
    }),
    [
      profiles,
      activeProfile,
      isLoading,
      workspace,
      setWorkspace,
      addProfile,
      updateProfile,
      removeProfile,
      switchProfile,
      themeMode,
      setThemeMode,
      languageMode,
      setLanguageMode,
      aiSettings,
      saveAiSettings,
    ],
  );

  return (
    <SettingsContext.Provider value={value}>
      <ThemeProvider mode={themeMode}>
        <I18nProvider mode={languageMode}>{children}</I18nProvider>
      </ThemeProvider>
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}

/** Совместимость: сброс рабочей области (используется при удалении всех серверов). */
export { clearWorkspace };
