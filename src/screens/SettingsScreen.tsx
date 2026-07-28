import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
import { BackupFile, GitSyncStatus, SharedItem, SystemInfo } from '../api/types';
import ActionSheet, { ActionSheetItem } from '../components/ActionSheet';
import { useDialog } from '../components/DialogProvider';
import { buildShareUrl } from '../utils/url';
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

  // Форма сервера: null = скрыта, 'new' = новый, profile = редактирование
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

  // Секции сервера
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [gitStatus, setGitStatus] = useState<GitSyncStatus | null>(null);
  const [backups, setBackups] = useState<BackupFile[] | null>(null);
  const [shared, setShared] = useState<SharedItem[] | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      navigation.reset({ index: 0, routes: [{ name: 'NotesList' }] });
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setIsChecking(false);
    }
  };

  const handleSwitch = async (profile: ServerProfile) => {
    await switchProfile(profile.id);
    navigation.reset({ index: 0, routes: [{ name: 'NotesList' }] });
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

  // ===== Секции активного сервера =====

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
      } catch {
        // секции вторичны — ошибки показываем молча
      } finally {
        setIsRefreshing(false);
      }
    },
    [client, workspace],
  );

  useFocusEffect(
    useCallback(() => {
      loadSections();
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
          // «Not Found» — стандартный ответ GitHub/Forgejo API при неверном
          // owner/repo или токене без доступа к репозиторию
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
        {/* Серверы */}
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

        {/* Форма сервера */}
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

        {/* Внешний вид */}
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

        {/* Язык */}
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

        {/* Безопасность (только нативные платформы) */}
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

        {/* Секции активного сервера */}
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
    busy: { marginVertical: 10 },
    hint: { marginTop: 24 },
    hintText: { fontSize: 12, color: colors.textFaint, lineHeight: 17 },
  });
