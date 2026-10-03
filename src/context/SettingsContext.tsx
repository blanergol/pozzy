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
import { runStartupMigration } from '../storage/secure';
import { ThemeMode, ThemeProvider } from '../theme/ThemeContext';
import { I18nProvider, LanguageMode } from '../i18n';
import {
  AISettings,
  clearWorkspace,
  DEFAULT_AI_SETTINGS,
  loadAISettings,
  loadLanguageMode,
  loadOnboardingSeen,
  loadSelectedWorkspace,
  loadServers,
  loadThemeMode,
  removeServerSecrets,
  saveAISettings,
  saveLanguageMode,
  saveOnboardingSeen,
  saveSelectedWorkspace,
  saveServers,
  saveThemeMode,
  ServerProfile,
} from '../storage/settings';

interface SettingsContextValue {
  /** All saved servers. */
  profiles: ServerProfile[];
  /** Active server (current connection). */
  activeProfile: ServerProfile | null;
  client: PoznoteClient | null;
  isLoading: boolean;
  /** Selected workspace; null = all workspaces. */
  workspace: string | null;
  setWorkspace: (workspace: string | null) => void;
  /** Add a new server and make it active. Returns the profile id. */
  addProfile: (settings: ServerSettings) => Promise<string>;
  /** Update an existing profile (id unchanged). */
  updateProfile: (profile: ServerProfile) => Promise<void>;
  /** Remove a profile. If the active one is removed, the first remaining one becomes active. */
  removeProfile: (id: string) => Promise<void>;
  /** Switch to another server. */
  switchProfile: (id: string) => Promise<void>;
  /** Theme mode. */
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  /** UI language. */
  languageMode: LanguageMode;
  setLanguageMode: (mode: LanguageMode) => void;
  /** OpenAI-compatible API settings for the AI chat. */
  aiSettings: AISettings;
  saveAiSettings: (settings: AISettings) => void;
  /** true = onboarding has already been shown (not shown again). */
  onboardingSeen: boolean;
  /** Mark onboarding as completed (written to the cache). */
  completeOnboarding: () => void;
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
  const [onboardingSeen, setOnboardingSeen] = useState(true); // not shown until loaded
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Storage migration (secrets → SecureStore, cache encryption) must run strictly before
    // loading profiles: otherwise SyncManager would start syncing on legacy data.
    runStartupMigration()
      .then(() =>
        Promise.all([loadServers(), loadSelectedWorkspace(), loadThemeMode(), loadLanguageMode(), loadAISettings(), loadOnboardingSeen()]),
      )
      .then(([serversStorage, loadedWorkspace, loadedTheme, loadedLanguage, loadedAI, loadedOnboarding]) => {
        setProfiles(serversStorage.servers);
        setActiveId(serversStorage.activeId);
        setWorkspaceState(loadedWorkspace);
        setThemeModeState(loadedTheme);
        setLanguageModeState(loadedLanguage);
        setAiSettings(loadedAI);
        setOnboardingSeen(loadedOnboarding);
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
      // The removed server's secrets, data key, offline cache, queue and attachment
      // files are no longer needed
      clearOfflineData(id).catch(() => {});
      removeServerSecrets(id).catch(() => {});
    },
    [profiles, activeId, persist],
  );

  const switchProfile = useCallback(
    async (id: string): Promise<void> => {
      if (id === activeId) return;
      persist(profiles, id);
      // the workspace is tied to the server: reset the filter
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

  const completeOnboarding = useCallback(() => {
    setOnboardingSeen(true);
    saveOnboardingSeen().catch(() => {});
  }, []);

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeId) ?? null,
    [profiles, activeId],
  );

  // The client depends only on the profile: a theme/language change must not
  // recreate it, otherwise every screen re-hits the API when its identity changes.
  const client = useMemo(
    () => (activeProfile ? new PoznoteClient(activeProfile) : null),
    [activeProfile],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      profiles,
      activeProfile,
      client,
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
      onboardingSeen,
      completeOnboarding,
    }),
    [
      profiles,
      activeProfile,
      client,
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
      onboardingSeen,
      completeOnboarding,
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

/** Compatibility: workspace reset (used when all servers are removed). */
export { clearWorkspace };
