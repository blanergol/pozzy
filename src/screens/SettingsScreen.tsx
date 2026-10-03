import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { describeError, normalizeBaseUrl, PoznoteClient } from '../api/client';
import { BackupFile, GitSyncConfig, GitSyncStatus, SharedItem, SystemInfo } from '../api/types';
import ActionSheet, { ActionSheetItem } from '../components/ActionSheet';
import { useDialog } from '../components/DialogProvider';
import { buildShareUrl } from '../utils/url';
import { freshMark, isFresh } from '../utils/freshness';
import { useSettings } from '../context/SettingsContext';
import { useAppLock } from '../security/AppLock';
import { ServerProfile } from '../storage/settings';
import { ThemeColors, ThemeMode, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { LanguageMode, useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const THEME_OPTIONS: { mode: ThemeMode; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { mode: 'system', labelKey: 'settings.themeSystem', icon: 'phone-portrait-outline' },
  { mode: 'light', labelKey: 'settings.themeLight', icon: 'sunny-outline' },
  { mode: 'dark', labelKey: 'settings.themeDark', icon: 'moon-outline' },
];

const LANG_OPTIONS: { mode: LanguageMode; labelKey: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { mode: 'system', labelKey: 'settings.langSystem', icon: 'globe-outline' },
  { mode: 'ru', labelKey: 'settings.langRu', icon: 'language-outline' },
  { mode: 'en', labelKey: 'settings.langEn', icon: 'language-outline' },
];

export default function SettingsScreen({ navigation }: Props) {
  const {
    profiles,
    activeProfile,
    client,
    addProfile,
    updateProfile,
    removeProfile,
    switchProfile,
    themeMode,
    setThemeMode,
    languageMode,
    setLanguageMode,
    workspace,
    aiSettings,
    saveAiSettings,
  } = useSettings();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const dialog = useDialog();
  const { t } = useI18n();
  const appLock = useAppLock();

  const handleToggleAppLock = async (value: boolean) => {
    if (value) {
      const ok = await appLock.enable();
      if (!ok) {
        dialog.alert(t('settings.appLock'), t('settings.appLockUnavailable'));
      }
    } else {
      await appLock.disable();
    }
  };

  // Server form: null = hidden, 'new' = new server, profile = editing
  const [formState, setFormState] = useState<'hidden' | 'new' | ServerProfile>(
    profiles.length === 0 ? 'new' : 'hidden',
  );
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [userId, setUserId] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [profileActions, setProfileActions] = useState<ServerProfile | null>(null);

  // AI chat form (OpenAI-compatible API)
  const [aiEnabled, setAiEnabled] = useState(aiSettings.enabled);
  const [aiBaseUrl, setAiBaseUrl] = useState(aiSettings.baseUrl);
  const [aiApiKey, setAiApiKey] = useState(aiSettings.apiKey);
  const [aiModel, setAiModel] = useState(aiSettings.model);
  const [aiSaved, setAiSaved] = useState(false);

  // Server sections
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [gitStatus, setGitStatus] = useState<GitSyncStatus | null>(null);
  const [backups, setBackups] = useState<BackupFile[] | null>(null);
  const [shared, setShared] = useState<SharedItem[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sectionsLoadedRef = useRef({ at: 0, version: -1 });

  // Git Sync settings form
  const [gitModalVisible, setGitModalVisible] = useState(false);
  const [gitProvider, setGitProvider] = useState<'github' | 'gitlab' | 'forgejo'>('github');
  const [gitRepo, setGitRepo] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [gitToken, setGitToken] = useState('');
  const [gitApiBase, setGitApiBase] = useState('');
  const [gitAuthorName, setGitAuthorName] = useState('');
  const [gitAuthorEmail, setGitAuthorEmail] = useState('');

  const profileDisplayName = (p: ServerProfile) =>
    `${p.username}@${p.baseUrl.replace(/^https?:\/\//, '')}`;

  const openNewForm = () => {
    setBaseUrl('');
    setUsername('');
    setPassword('');
    setUserId('');
    setFormError(null);
    setFormState('new');
  };

  const openEditForm = (profile: ServerProfile) => {
    setBaseUrl(profile.baseUrl);
    setUsername(profile.username);
    setPassword(profile.password);
    setUserId(profile.userId);
    setFormError(null);
    setFormState(profile);
  };

  const canSubmit =
    baseUrl.trim().length > 0 && username.trim().length > 0 && password.length > 0 && !isChecking;

  const handleSubmit = async () => {
    setFormError(null);
    setIsChecking(true);
    try {
      const normalized = normalizeBaseUrl(baseUrl);
      const candidate = {
        baseUrl: normalized,
        username: username.trim(),
        password,
        userId: userId.trim(),
      };
      const probe = new PoznoteClient(candidate);
      const me = await probe.getMe();
      if (!candidate.userId) {
        candidate.userId = String(me.id);
        setUserId(candidate.userId);
      }
      await probe.listNotes();

      if (formState === 'new') {
        await addProfile(candidate);
      } else if (formState !== 'hidden') {
        await updateProfile({ ...candidate, id: formState.id });
        if (formState.id !== activeProfile?.id) {
          await switchProfile(formState.id);
        }
      }
      setFormState('hidden');
      navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setIsChecking(false);
    }
  };

  const handleSwitch = async (profile: ServerProfile) => {
    await switchProfile(profile.id);
    navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
  };

  const profileActionItems = useCallback((): ActionSheetItem[] => {
    if (!profileActions) return [];
    const profile = profileActions;
    const items: ActionSheetItem[] = [
      {
        label: t('settings.edit'),
        icon: 'pencil-outline',
        onPress: () => openEditForm(profile),
      },
      {
        label: t('settings.deleteProfile'),
        icon: 'trash-outline',
        destructive: true,
        onPress: () =>
          dialog.alert(t('settings.deleteServer'), profileDisplayName(profile), [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('common.delete'),
              style: 'destructive',
              onPress: async () => {
                await removeProfile(profile.id);
                if (profile.id === activeProfile?.id && profiles.length <= 1) {
                  setFormState('new');
                }
              },
            },
          ]),
      },
    ];
    if (profile.id !== activeProfile?.id) {
      items.unshift({
        label: t('settings.switchProfile'),
        icon: 'swap-horizontal-outline',
        onPress: () => handleSwitch(profile),
      });
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileActions, activeProfile, profiles.length, removeProfile, t, dialog]);

  // ===== Active server sections =====

  const loadSections = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!client) return;
      if (mode === 'refresh') setIsRefreshing(true);
      try {
        const [version, git, backupList, sharedList] = await Promise.allSettled([
          client.getSystemVersion(),
          client.getGitSyncStatus(),
          client.listBackups(),
          client.listShared(workspace ?? undefined),
        ]);
        if (version.status === 'fulfilled') setSystemInfo(version.value);
        if (git.status === 'fulfilled') setGitStatus(git.value);
        if (backupList.status === 'fulfilled') setBackups(backupList.value);
        if (sharedList.status === 'fulfilled') setShared(sharedList.value);
        sectionsLoadedRef.current = freshMark();
      } catch {
        // sections are secondary: errors are swallowed silently
      } finally {
        setIsRefreshing(false);
      }
    },
    [client, workspace],
  );

  useFocusEffect(
    useCallback(() => {
      // Re-entering settings doesn't fire 4 requests if the data is still fresh
      if (!isFresh(sectionsLoadedRef.current)) loadSections();
    }, [loadSections]),
  );

  const runAction = async (action: () => Promise<void>) => {
    setIsBusy(true);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsBusy(false);
    }
  };

  const handleCheckUpdates = () =>
    runAction(async () => {
      const info = await client!.checkUpdates();
      const hasUpdate = info.update_available ?? info.has_update ?? false;
      if (hasUpdate) {
        dialog.alert(
          t('settings.updateAvailable'),
          t('settings.updateLatest', { version: info.latest_version ?? '?' }),
        );
      } else {
        dialog.alert(t('settings.upToDate'), t('settings.upToDateMessage'));
      }
    });

  const handleGitAction = (action: 'test' | 'push' | 'pull') =>
    runAction(async () => {
      if (action === 'test') {
        const res = await client!.testGitSync();
        if (res.success) {
          dialog.alert(t('settings.testOk'), res.message ?? t('settings.testOkMessage'));
        } else {
          const serverError = res.error ?? res.message ?? t('settings.testFailUnknown');
          // "Not Found" is the standard GitHub/Forgejo API response for a wrong
          // owner/repo or a token without access to the repository
          const hint = /not found/i.test(serverError) ? t('settings.testNotFoundHint') : '';
          dialog.alert(t('settings.testFail'), serverError + hint);
        }
      } else if (action === 'push') {
        await client!.pushGitSync();
        dialog.alert(t('settings.done'), t('settings.pushDone'));
      } else {
        await client!.pullGitSync();
        dialog.alert(t('settings.done'), t('settings.pullDone'));
      }
    });

  const openGitConfig = () => {
    const cfg = gitStatus?.config;
    const provider = cfg?.provider;
    setGitProvider(provider === 'gitlab' || provider === 'forgejo' ? provider : 'github');
    setGitRepo(cfg?.repo ?? '');
    setGitBranch(cfg?.branch ?? 'main');
    setGitToken('');
    setGitApiBase(cfg?.apiBase ?? '');
    setGitAuthorName(cfg?.authorName ?? '');
    setGitAuthorEmail(cfg?.authorEmail ?? '');
    setGitModalVisible(true);
  };

  const canSaveGit = gitRepo.trim().length > 0 && !isBusy;

  const handleSaveGitConfig = () =>
    runAction(async () => {
      const body: GitSyncConfig = {
        provider: gitProvider,
        repo: gitRepo.trim(),
        branch: gitBranch.trim() || 'main',
        author_name: gitAuthorName.trim(),
        author_email: gitAuthorEmail.trim(),
      };
      if (gitProvider !== 'github') body.api_base = gitApiBase.trim();
      // Don't send an empty token: the server keeps the stored one
      if (gitToken.trim()) body.token = gitToken.trim();
      await client!.updateGitSyncConfig(body);
      setGitModalVisible(false);
      await loadSections('refresh');
      dialog.alert(t('settings.done'), t('settings.gitSaved'));
    });

  const handleDeleteGitConfig = () => {
    dialog.alert(t('settings.gitDeleteTitle'), t('settings.gitDeleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () =>
          runAction(async () => {
            // The API has no DELETE endpoint: empty values clear the fields on the server
            await client!.updateGitSyncConfig({
              repo: '',
              token: '',
              api_base: '',
              author_name: '',
              author_email: '',
            });
            await loadSections('refresh');
          }),
      },
    ]);
  };

  const handleCreateBackup = () =>
    runAction(async () => {
      const res = await client!.createBackup();
      dialog.alert(t('settings.backupCreated'), res.filename ?? '');
      await loadSections('refresh');
    });

  const handleDeleteBackup = (backup: BackupFile) => {
    dialog.alert(t('settings.deleteBackup'), backup.filename, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () =>
          runAction(async () => {
            await client!.deleteBackup(backup.filename);
            await loadSections('refresh');
          }),
      },
    ]);
  };

  const handleShareLink = (item: SharedItem) => {
    if (typeof item.url !== 'string' || !activeProfile) return;
    const url = buildShareUrl(
      { url: item.url, url_query: typeof item.url_query === 'string' ? item.url_query : undefined },
      activeProfile.baseUrl,
    );
    Share.share({ message: url }).catch(() => {});
  };

  const formVisible = formState !== 'hidden';
  const showSections = client !== null && !formVisible;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => loadSections('refresh')}
            tintColor={colors.accent}
          />
        }
      >
        {/* Servers */}
        {profiles.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>{t('settings.servers')}</Text>
            <View style={styles.card}>
              {profiles.map((p) => (
                <TouchableOpacity
                  key={p.id}
                  style={styles.profileRow}
                  onPress={() => handleSwitch(p)}
                >
                  <Ionicons
                    name={p.id === activeProfile?.id ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={p.id === activeProfile?.id ? colors.accent : colors.textFaint}
                    style={styles.profileIcon}
                  />
                  <View style={styles.profileBody}>
                    <Text style={styles.profileName} numberOfLines={1}>
                      {profileDisplayName(p)}
                    </Text>
                    {p.userId ? (
                      <Text style={styles.profileMeta}>{t('settings.profileN', { id: p.userId })}</Text>
                    ) : null}
                  </View>
                  <TouchableOpacity onPress={() => setProfileActions(p)} hitSlop={8} accessibilityLabel="profile-actions">
                    <Ionicons name="ellipsis-vertical" size={18} color={colors.textFaint} />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
              {!formVisible ? (
                <TouchableOpacity style={styles.actionRow} onPress={openNewForm}>
                  <Ionicons name="add-circle-outline" size={20} color={colors.accent} />
                  <Text style={styles.actionText}>{t('settings.addServer')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </>
        ) : null}

        {/* Server form */}
        {formVisible ? (
          <>
            <Text style={styles.sectionTitle}>
              {formState === 'new' ? t('settings.newServer') : t('settings.editServer')}
            </Text>
            <View style={styles.card}>
              {profiles.length === 0 ? (
                <Text style={styles.formHint}>{t('settings.formHint')}</Text>
              ) : null}

              <Text style={styles.label}>{t('settings.serverUrl')}</Text>
              <TextInput
                style={styles.input}
                value={baseUrl}
                onChangeText={setBaseUrl}
                placeholder="https://poznote.example.com"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <Text style={styles.label}>{t('settings.username')}</Text>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                placeholder="admin"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.label}>{t('settings.password')}</Text>
              <TextInput
                style={styles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="••••••"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.label}>{t('settings.userId')}</Text>
              <TextInput
                style={styles.input}
                value={userId}
                onChangeText={setUserId}
                placeholder={t('settings.userIdPlaceholder')}
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="number-pad"
              />

              {formError ? <Text style={styles.errorText}>{formError}</Text> : null}

              <TouchableOpacity
                style={[styles.button, !canSubmit && styles.buttonDisabled]}
                onPress={handleSubmit}
                disabled={!canSubmit}
              >
                {isChecking ? (
                  <ActivityIndicator color={colors.accentText} />
                ) : (
                  <Text style={styles.buttonText}>{t('settings.submit')}</Text>
                )}
              </TouchableOpacity>

              {formState !== 'new' || profiles.length > 0 ? (
                <TouchableOpacity style={styles.formCancel} onPress={() => setFormState('hidden')}>
                  <Text style={styles.formCancelText}>{t('common.cancel')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </>
        ) : null}

        {/* Appearance */}
        <Text style={styles.sectionTitle}>{t('settings.appearance')}</Text>
        <View style={styles.card}>
          <View style={styles.themeRow}>
            {THEME_OPTIONS.map((option) => {
              const active = themeMode === option.mode;
              return (
                <TouchableOpacity
                  key={option.mode}
                  style={[styles.themeOption, active && styles.themeOptionActive]}
                  onPress={() => setThemeMode(option.mode)}
                >
                  <Ionicons
                    name={option.icon}
                    size={20}
                    color={active ? colors.accent : colors.textFaint}
                  />
                  <Text style={[styles.themeOptionText, active && styles.themeOptionTextActive]}>
                    {t(option.labelKey as never)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Language */}
        <Text style={styles.sectionTitle}>{t('settings.language')}</Text>
        <View style={styles.card}>
          <View style={styles.themeRow}>
            {LANG_OPTIONS.map((option) => {
              const active = languageMode === option.mode;
              return (
                <TouchableOpacity
                  key={option.mode}
                  style={[styles.themeOption, active && styles.themeOptionActive]}
                  onPress={() => setLanguageMode(option.mode)}
                >
                  <Ionicons
                    name={option.icon}
                    size={20}
                    color={active ? colors.accent : colors.textFaint}
                  />
                  <Text style={[styles.themeOptionText, active && styles.themeOptionTextActive]}>
                    {t(option.labelKey as never)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* AI chat */}
        <Text style={styles.sectionTitle}>{t('settings.aiSection')}</Text>
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.rowLabel}>{t('settings.aiEnabled')}</Text>
            <Switch
              value={aiEnabled}
              onValueChange={(value) => {
                setAiEnabled(value);
                saveAiSettings({
                  enabled: value,
                  baseUrl: aiBaseUrl.trim(),
                  apiKey: aiApiKey.trim(),
                  model: aiModel.trim(),
                });
              }}
              trackColor={{ false: colors.border, true: colors.accent }}
              thumbColor={colors.accentText}
              accessibilityLabel={t('settings.aiEnabled')}
            />
          </View>

          {aiEnabled ? (
            <>
              <Text style={styles.label}>{t('settings.aiBaseUrl')}</Text>
              <TextInput
                style={styles.input}
                value={aiBaseUrl}
                onChangeText={(v) => {
                  setAiBaseUrl(v);
                  setAiSaved(false);
                }}
                placeholder="https://api.openai.com/v1"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />

              <Text style={styles.label}>{t('settings.aiApiKey')}</Text>
              <TextInput
                style={styles.input}
                value={aiApiKey}
                onChangeText={(v) => {
                  setAiApiKey(v);
                  setAiSaved(false);
                }}
                placeholder="sk-..."
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.label}>{t('settings.aiModel')}</Text>
              <TextInput
                style={styles.input}
                value={aiModel}
                onChangeText={(v) => {
                  setAiModel(v);
                  setAiSaved(false);
                }}
                placeholder="gpt-4o-mini"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <TouchableOpacity
                style={styles.button}
                onPress={() => {
                  saveAiSettings({
                    enabled: aiEnabled,
                    baseUrl: aiBaseUrl.trim(),
                    apiKey: aiApiKey.trim(),
                    model: aiModel.trim(),
                  });
                  setAiSaved(true);
                }}
                accessibilityLabel={t('settings.aiSave')}
              >
                <Text style={styles.buttonText}>
                  {aiSaved ? t('settings.aiSaved') : t('settings.aiSave')}
                </Text>
              </TouchableOpacity>
            </>
          ) : null}
        </View>

        {/* Security (native platforms only) */}
        {Platform.OS !== 'web' && appLock.isReady ? (
          <>
            <Text style={styles.sectionTitle}>{t('settings.security')}</Text>
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <View style={styles.securityBody}>
                  <Text style={styles.rowLabel}>{t('settings.appLock')}</Text>
                  <Text style={styles.securityHint}>{t('settings.appLockHint')}</Text>
                </View>
                <Switch
                  value={appLock.enabled}
                  onValueChange={handleToggleAppLock}
                  trackColor={{ false: colors.border, true: colors.accent }}
                  thumbColor={colors.accentText}
                />
              </View>
            </View>
          </>
        ) : null}

        {/* Active server sections */}
        {showSections ? (
          <>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            {isBusy ? <ActivityIndicator color={colors.accent} style={styles.busy} /> : null}

            <Text style={styles.sectionTitle}>{t('settings.system')}</Text>
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.rowLabel}>{t('settings.serverVersion')}</Text>
                <Text style={styles.rowValue}>{systemInfo?.current_version ?? '—'}</Text>
              </View>
              <TouchableOpacity style={styles.actionRow} onPress={handleCheckUpdates}>
                <Ionicons name="cloud-download-outline" size={20} color={colors.accent} />
                <Text style={styles.actionText}>{t('settings.checkUpdates')}</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.sectionTitle}>{t('settings.gitSync')}</Text>
            <View style={styles.card}>
              <View style={styles.rowBetween}>
                <Text style={styles.rowLabel}>{t('settings.status')}</Text>
                <Text style={styles.rowValue}>
                  {gitStatus === null
                    ? '—'
                    : gitStatus.enabled === false
                      ? t('settings.statusDisabled')
                      : gitStatus.config?.configured
                        ? t('settings.statusConfigured')
                        : t('settings.statusNotConfigured')}
                </Text>
              </View>
              {gitStatus?.config?.repo ? (
                <View style={styles.rowBetween}>
                  <Text style={styles.rowLabel}>{t('settings.repository')}</Text>
                  <Text style={styles.rowValueSmall} numberOfLines={1}>
                    {gitStatus.config.repo}
                    {gitStatus.config.branch ? ` (${gitStatus.config.branch})` : ''}
                  </Text>
                </View>
              ) : null}
              {gitStatus?.enabled !== false ? (
                <TouchableOpacity style={styles.actionRow} onPress={openGitConfig}>
                  <Ionicons name="create-outline" size={20} color={colors.accent} />
                  <Text style={styles.actionText}>{t('settings.gitConfigure')}</Text>
                </TouchableOpacity>
              ) : null}
              {gitStatus?.config?.configured ? (
                <View style={styles.buttonRow}>
                  <TouchableOpacity style={styles.actionRow} onPress={() => handleGitAction('test')}>
                    <Ionicons name="git-network-outline" size={20} color={colors.accent} />
                    <Text style={styles.actionText}>{t('settings.test')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.actionRow} onPress={() => handleGitAction('push')}>
                    <Ionicons name="cloud-upload-outline" size={20} color={colors.accent} />
                    <Text style={styles.actionText}>{t('settings.push')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.actionRow} onPress={() => handleGitAction('pull')}>
                    <Ionicons name="cloud-download-outline" size={20} color={colors.accent} />
                    <Text style={styles.actionText}>{t('settings.pull')}</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              {gitStatus?.enabled !== false && gitStatus?.config?.configured ? (
                <TouchableOpacity style={styles.actionRow} onPress={handleDeleteGitConfig}>
                  <Ionicons name="trash-outline" size={20} color={colors.danger} />
                  <Text style={styles.actionTextDanger}>{t('settings.gitDelete')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <Text style={styles.sectionTitle}>{t('settings.backups')}</Text>
            <View style={styles.card}>
              <TouchableOpacity style={styles.actionRow} onPress={handleCreateBackup}>
                <Ionicons name="archive-outline" size={20} color={colors.accent} />
                <Text style={styles.actionText}>{t('settings.createBackup')}</Text>
              </TouchableOpacity>
              {backups === null ? (
                <ActivityIndicator color={colors.accent} style={styles.busy} />
              ) : backups.length === 0 ? (
                <Text style={styles.emptyText}>{t('settings.noBackups')}</Text>
              ) : (
                backups.map((b) => (
                  <View key={b.filename} style={styles.listRow}>
                    <View style={styles.listRowBody}>
                      <Text style={styles.listRowTitle} numberOfLines={1}>
                        {b.filename}
                      </Text>
                      <Text style={styles.listRowMeta}>
                        {[b.size_mb !== undefined ? `${b.size_mb} MB` : null, b.created ?? null]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <TouchableOpacity onPress={() => handleDeleteBackup(b)} hitSlop={8}>
                      <Ionicons name="trash-outline" size={18} color={colors.danger} />
                    </TouchableOpacity>
                  </View>
                ))
              )}
            </View>

            <Text style={styles.sectionTitle}>{t('settings.publicLinks')}</Text>
            <View style={styles.card}>
              {shared === null ? (
                <ActivityIndicator color={colors.accent} style={styles.busy} />
              ) : shared.length === 0 ? (
                <Text style={styles.emptyText}>{t('settings.noLinks')}</Text>
              ) : (
                shared.map((item, index) => (
                  <TouchableOpacity
                    key={String(item.token ?? item.id ?? index)}
                    style={styles.listRow}
                    onPress={() => handleShareLink(item)}
                  >
                    <View style={styles.listRowBody}>
                      <Text style={styles.listRowTitle} numberOfLines={1}>
                        {item.heading ?? item.type ?? t('settings.linkFallback')}
                      </Text>
                    </View>
                    <Ionicons name="share-social-outline" size={18} color={colors.accent} />
                  </TouchableOpacity>
                ))
              )}
            </View>
          </>
        ) : null}

        {profiles.length === 0 ? (
          <View style={styles.hint}>
            <Text style={styles.hintText}>{t('settings.certHint')}</Text>
          </View>
        ) : null}
      </ScrollView>

      <ActionSheet
        visible={profileActions !== null}
        title={profileActions ? profileDisplayName(profileActions) : undefined}
        items={profileActionItems()}
        onClose={() => setProfileActions(null)}
      />

      {/* Git Sync settings */}
      <Modal
        visible={gitModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setGitModalVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.gitOverlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.gitCard}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.gitTitle}>{t('settings.gitSync')}</Text>

              <Text style={styles.label}>{t('settings.gitProvider')}</Text>
              <View style={styles.themeRow}>
                {(['github', 'gitlab', 'forgejo'] as const).map((p) => {
                  const active = gitProvider === p;
                  return (
                    <TouchableOpacity
                      key={p}
                      style={[styles.themeOption, active && styles.themeOptionActive]}
                      onPress={() => setGitProvider(p)}
                      accessibilityLabel={p}
                    >
                      <Text
                        style={[styles.themeOptionText, active && styles.themeOptionTextActive]}
                      >
                        {p === 'github' ? 'GitHub' : p === 'gitlab' ? 'GitLab' : 'Forgejo'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.label}>{t('settings.repository')}</Text>
              <TextInput
                style={styles.input}
                value={gitRepo}
                onChangeText={setGitRepo}
                placeholder="owner/repo"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.label}>{t('settings.gitBranch')}</Text>
              <TextInput
                style={styles.input}
                value={gitBranch}
                onChangeText={setGitBranch}
                placeholder="main"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.label}>{t('settings.gitToken')}</Text>
              <TextInput
                style={styles.input}
                value={gitToken}
                onChangeText={setGitToken}
                placeholder={
                  gitStatus?.config?.hasToken ? t('settings.gitTokenKeep') : 'ghp_…'
                }
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />

              {gitProvider !== 'github' ? (
                <>
                  <Text style={styles.label}>{t('settings.gitApiBase')}</Text>
                  <TextInput
                    style={styles.input}
                    value={gitApiBase}
                    onChangeText={setGitApiBase}
                    placeholder={
                      gitProvider === 'gitlab'
                        ? 'https://gitlab.com/api/v4'
                        : 'https://forgejo.example.com/api/v1'
                    }
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                </>
              ) : null}

              <Text style={styles.label}>{t('settings.gitAuthorName')}</Text>
              <TextInput
                style={styles.input}
                value={gitAuthorName}
                onChangeText={setGitAuthorName}
                placeholder="Poznote"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="words"
                autoCorrect={false}
              />

              <Text style={styles.label}>{t('settings.gitAuthorEmail')}</Text>
              <TextInput
                style={styles.input}
                value={gitAuthorEmail}
                onChangeText={setGitAuthorEmail}
                placeholder="poznote@localhost"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
              />

              <TouchableOpacity
                style={[styles.button, !canSaveGit && styles.buttonDisabled]}
                onPress={handleSaveGitConfig}
                disabled={!canSaveGit}
                accessibilityLabel={t('common.save')}
              >
                {isBusy ? (
                  <ActivityIndicator color={colors.accentText} />
                ) : (
                  <Text style={styles.buttonText}>{t('common.save')}</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.formCancel}
                onPress={() => setGitModalVisible(false)}
              >
                <Text style={styles.formCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    container: { padding: 16, paddingBottom: 48 },
    sectionTitle: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textSecondary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 20,
      marginBottom: 8,
    },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 14 },
    profileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    profileIcon: { marginRight: 12 },
    profileBody: { flex: 1, marginRight: 10 },
    profileName: { fontSize: 15, fontWeight: '600', color: colors.text },
    profileMeta: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
    formHint: { fontSize: 13, color: colors.textSecondary, marginBottom: 8 },
    label: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSecondary,
      marginBottom: 6,
      marginTop: 12,
    },
    input: {
      backgroundColor: colors.inputBg,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 16,
      color: colors.text,
    },
    button: {
      marginTop: 20,
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingVertical: 14,
      alignItems: 'center',
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: colors.accentText, fontSize: 16, fontWeight: '600' },
    formCancel: { marginTop: 14, alignItems: 'center' },
    formCancelText: { fontSize: 15, color: colors.textFaint },
    themeRow: { flexDirection: 'row', gap: 10 },
    themeOption: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
    },
    themeOptionActive: { borderColor: colors.accent, backgroundColor: colors.bg },
    themeOptionText: { fontSize: 13, color: colors.textFaint },
    themeOptionTextActive: { color: colors.accent, fontWeight: '600' },
    rowBetween: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: 6,
    },
    rowLabel: { fontSize: 15, color: colors.text },
    securityBody: { flex: 1, marginRight: 12 },
    securityHint: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
    rowValue: { fontSize: 15, color: colors.textFaint },
    rowValueSmall: { fontSize: 13, color: colors.textFaint, maxWidth: '60%' },
    buttonRow: { flexDirection: 'row', gap: 24, marginTop: 4 },
    actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
    actionText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
    listRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderLight,
    },
    listRowBody: { flex: 1, marginRight: 10 },
    listRowTitle: { fontSize: 14, color: colors.text },
    listRowMeta: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
    emptyText: { fontSize: 14, color: colors.textFaint, textAlign: 'center', paddingVertical: 12 },
    errorText: { fontSize: 14, color: colors.danger, textAlign: 'center', marginTop: 12 },
    actionTextDanger: { fontSize: 15, color: colors.danger, fontWeight: '600' },
    gitOverlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: 'center',
      padding: 24,
    },
    gitCard: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 20,
      maxHeight: '90%',
    },
    gitTitle: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 4 },
    busy: { marginVertical: 10 },
    hint: { marginTop: 24 },
    hintText: { fontSize: 12, color: colors.textFaint, lineHeight: 17 },
  });
