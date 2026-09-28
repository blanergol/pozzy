import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { describeError, LockConflictError } from '../api/client';
import { Backlink, Folder, NoteDetails, SnapshotInfo } from '../api/types';
import AttachmentsModal from '../components/AttachmentsModal';
import ActionSheet, { ActionSheetItem } from '../components/ActionSheet';
import OfflineBanner from '../components/OfflineBanner';
import { useDialog } from '../components/DialogProvider';
import { buildShareUrl } from '../utils/url';
import { useAndroidKeyboardPadding } from '../utils/keyboard';
import { useSettings } from '../context/SettingsContext';
import { useConnectivity } from '../context/ConnectivityContext';
import {
  RepoContext,
  isTempNoteId,
  repoDeleteNote,
  repoGetNote,
  repoToggleFavorite,
  repoUpdateNote,
} from '../data/notesRepository';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { bumpDataVersion } from '../utils/freshness';
import { dateLocale, Locale, useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'NoteEditor'>;

// Уникальный ID сессии редактирования на время жизни приложения (для edit-lock'ов)
const EDITOR_SESSION_ID =
  'mobile-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

const LOCK_HEARTBEAT_MS = 45_000;
// Задержка автосохранения после последнего ввода
const AUTOSAVE_DEBOUNCE_MS = 1_000;

function formatDateTime(value: string | null | undefined, locale: Locale): string {
  if (!value) return '';
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(dateLocale(locale), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NoteEditorScreen({ navigation, route }: Props) {
  const { noteId } = route.params;
  const { client, activeProfile } = useSettings();
  const { isOnline, reportNetworkError, reportSuccess } = useConnectivity();
  const dialog = useDialog();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  // На Android 15+ отступ равен полной высоте клавиатуры:
  // endCoordinates.height уже не включает системный инсет навигации.
  const bottomPadding = useAndroidKeyboardPadding();
  const { t, locale } = useI18n();

  // Локальная заметка, созданная оффлайн (ещё не существует на сервере)
  const isTemp = isTempNoteId(noteId);

  const [note, setNote] = useState<NoteDetails | null>(null);
  const [heading, setHeading] = useState('');
  const [tags, setTags] = useState('');
  const [content, setContent] = useState('');
  const [favorite, setFavorite] = useState(route.params.favorite ?? 0);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [savedLocally, setSavedLocally] = useState(false);
  const [lockedByOther, setLockedByOther] = useState<string | null>(null);
  const [snapshotsVisible, setSnapshotsVisible] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  const [backlinksVisible, setBacklinksVisible] = useState(false);
  const [backlinks, setBacklinks] = useState<Backlink[] | null>(null);
  const [foldersVisible, setFoldersVisible] = useState(false);
  const [folderList, setFolderList] = useState<Folder[] | null>(null);
  const [attachmentsVisible, setAttachmentsVisible] = useState(false);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [reminderVisible, setReminderVisible] = useState(false);

  const lockHeldRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Контекст репозитория всегда актуален через ref — колбэки load/save
  // не пересоздаются при смене connectivity (иначе load() сбрасывал бы ввод).
  const repoCtxRef = useRef<RepoContext | null>(null);
  useEffect(() => {
    repoCtxRef.current = client
      ? {
          client,
          profileId: activeProfile?.id ?? null,
          isOnline,
          reportNetworkError,
          reportSuccess,
        }
      : null;
  }, [client, activeProfile, isOnline, reportNetworkError, reportSuccess]);

  const isOnlineRef = useRef(isOnline);
  useEffect(() => {
    isOnlineRef.current = isOnline;
  }, [isOnline]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const releaseLock = useCallback(() => {
    if (!client || !lockHeldRef.current) return;
    lockHeldRef.current = false;
    stopHeartbeat();
    client.releaseLock(noteId, EDITOR_SESSION_ID).catch(() => {});
  }, [client, noteId, stopHeartbeat]);

  const acquireLock = useCallback(async () => {
    // Оффлайн и локальные заметки без серверного id локи не используют
    if (!client || !isOnlineRef.current || isTempNoteId(noteId)) return;
    try {
      await client.acquireLock(noteId, EDITOR_SESSION_ID);
      lockHeldRef.current = true;
      setLockedByOther(null);
      stopHeartbeat();
      heartbeatRef.current = setInterval(() => {
        client.heartbeatLock(noteId, EDITOR_SESSION_ID).catch((e) => {
          if (e instanceof LockConflictError) {
            lockHeldRef.current = false;
            stopHeartbeat();
            setLockedByOther(t('editor.lockBanner'));
          }
        });
      }, LOCK_HEARTBEAT_MS);
    } catch (e) {
      if (e instanceof LockConflictError) {
        setLockedByOther(t('editor.lockReadOnly'));
      }
      // прочие ошибки лока не блокируют работу: сервер сам захватит лок при сохранении
    }
  }, [client, noteId, stopHeartbeat, t]);

  const load = useCallback(async () => {
    const ctx = repoCtxRef.current;
    if (!ctx) return;
    setIsLoading(true);
    try {
      const fresh = await repoGetNote(ctx, noteId);
      setNote(fresh);
      setHeading(fresh.heading ?? '');
      setTags(fresh.tags ?? '');
      setContent(fresh.content ?? '');
      setError(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    load().then(acquireLock);
    return () => {
      releaseLock();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const isDirty =
    note !== null &&
    (heading !== (note.heading ?? '') ||
      tags !== (note.tags ?? '') ||
      content !== (note.content ?? ''));

  // ===== Автосохранение =====

  const valuesRef = useRef({ heading: '', tags: '', content: '' });
  const isDirtyRef = useRef(false);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockedRef = useRef<string | null>(null);
  useEffect(() => {
    lockedRef.current = lockedByOther;
  }, [lockedByOther]);

  const performSave = useCallback(async () => {
    const ctx = repoCtxRef.current;
    if (!ctx || savingRef.current) return;
    if (!isDirtyRef.current || lockedRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    const { heading: h, tags: tg, content: c } = valuesRef.current;
    const nextHeading = h.trim() || t('common.untitled');
    try {
      await repoUpdateNote(ctx, noteId, { heading: nextHeading, content: c, tags: tg }, EDITOR_SESSION_ID);
      // Сбрасываем «грязность» только по сохранённым значениям: если за время
      // сохранения пользователь ввёл ещё — поля останутся отличающимися и
      // автосохранение сработает повторно.
      setNote((prev) => (prev ? { ...prev, heading: nextHeading, content: c, tags: tg } : prev));
      setSavedAt(
        new Date().toLocaleTimeString(dateLocale(locale), { hour: '2-digit', minute: '2-digit' }),
      );
      setSavedLocally(!isOnlineRef.current || isTempNoteId(noteId));
      setError(null);
    } catch (e) {
      if (e instanceof LockConflictError) {
        setLockedByOther(t('editor.lockReadOnly'));
      }
      setError(describeError(e));
    } finally {
      savingRef.current = false;
      setIsSaving(false);
      if (isDirtyRef.current && !lockedRef.current) {
        scheduleSaveRef.current?.();
      }
    }
  }, [noteId, t, locale]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void performSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [performSave]);

  const scheduleSaveRef = useRef(scheduleSave);
  useEffect(() => {
    scheduleSaveRef.current = scheduleSave;
  }, [scheduleSave]);
  const performSaveRef = useRef(performSave);
  useEffect(() => {
    performSaveRef.current = performSave;
  }, [performSave]);

  // Любое изменение полей → отложенное автосохранение
  useEffect(() => {
    valuesRef.current = { heading, tags, content };
    isDirtyRef.current = isDirty;
    if (isDirty && !lockedByOther) scheduleSave();
  }, [heading, tags, content, isDirty, lockedByOther, scheduleSave]);

  // При уходе с экрана — немедленный flush несохранённого
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (isDirtyRef.current && !lockedRef.current) {
        // fire-and-forget: оффлайн запишется в кэш, онлайн — попробует уйти на сервер
        void performSaveRef.current();
      }
    },
    [],
  );

  const handleToggleFavorite = useCallback(async () => {
    const ctx = repoCtxRef.current;
    if (!ctx || !note) return;
    const prev = favorite;
    setFavorite(prev ? 0 : 1);
    try {
      await repoToggleFavorite(ctx, note.id);
    } catch {
      setFavorite(prev);
    }
  }, [note, favorite]);

  const handleDelete = useCallback(() => {
    if (!client || !note) return;
    dialog.alert(t('editor.deleteTitle'), t('editor.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          const ctx = repoCtxRef.current;
          if (!ctx) return;
          try {
            await repoDeleteNote(ctx, note.id);
            navigation.goBack();
          } catch (e) {
            setError(describeError(e));
          }
        },
      },
    ]);
  }, [client, note, navigation, dialog, t]);

  const handleDuplicate = useCallback(() => {
    if (!client || !note) return;
    dialog.alert(t('editor.duplicateTitle'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('editor.duplicate'),
        onPress: async () => {
          try {
            const newId = await client.duplicateNote(note.id);
            if (newId) {
              navigation.replace('NoteEditor', { noteId: newId, favorite: 0 });
            } else {
              navigation.goBack();
            }
          } catch (e) {
            setError(describeError(e));
          }
        },
      },
    ]);
  }, [client, note, navigation, dialog, t]);

  const handleConvert = useCallback(() => {
    if (!client || !note) return;
    const target = note.type === 'markdown' ? 'html' : 'markdown';
    const targetLabel = target === 'markdown' ? 'Markdown' : 'HTML';
    dialog.alert(t('editor.convertTitle', { target: targetLabel }), t('editor.convertMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('editor.convert'),
        onPress: async () => {
          try {
            await client.convertNote(note.id, target);
            await load();
          } catch (e) {
            setError(describeError(e));
          }
        },
      },
    ]);
  }, [client, note, load, dialog, t]);

  const handleShare = useCallback(async () => {
    if (!client || !note || !activeProfile) return;
    try {
      const status = await client.getShareStatus(note.id);
      if (!status.public) {
        dialog.alert(t('editor.shareCreateTitle'), t('editor.shareCreateMessage'), [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('editor.shareCreate'),
            onPress: async () => {
              try {
                const created = await client.createShare(note.id, {});
                const url = buildShareUrl(created, activeProfile.baseUrl);
                try {
                  await Share.share({ message: url });
                } catch {
                  dialog.alert(t('editor.shareUrlTitle'), url);
                }
              } catch (e) {
                setError(describeError(e));
              }
            },
          },
        ]);
      } else {
        const url = buildShareUrl(status, activeProfile.baseUrl);
        dialog.alert(t('editor.shareActiveTitle'), url, [
          { text: t('common.close'), style: 'cancel' },
          {
            text: t('editor.shareSend'),
            onPress: () => {
              Share.share({ message: url }).catch(() => {
                dialog.alert(t('editor.shareUrlTitle'), url);
              });
            },
          },
          {
            text: t('editor.shareRevoke'),
            style: 'destructive',
            onPress: async () => {
              try {
                await client.deleteShare(note.id);
              } catch (e) {
                setError(describeError(e));
              }
            },
          },
        ]);
      }
    } catch (e) {
      setError(describeError(e));
    }
  }, [client, note, activeProfile, dialog, t]);

  const handleReminder = useCallback(() => {
    setReminderVisible(true);
  }, []);

  const reminderItems = useCallback((): ActionSheetItem[] => {
    if (!client || !note) return [];
    const setReminder = (date: Date) => {
      client
        .setNoteReminder(note.id, { reminder_at: date.toISOString() })
        .then(load)
        .catch((e) => setError(describeError(e)));
    };
    const inHour = new Date(Date.now() + 60 * 60 * 1000);
    const tomorrow9 = new Date();
    tomorrow9.setDate(tomorrow9.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);
    const inWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const items: ActionSheetItem[] = [
      {
        label: t('editor.reminderInHour', { time: formatDateTime(inHour.toISOString(), locale) }),
        icon: 'time-outline',
        onPress: () => setReminder(inHour),
      },
      {
        label: t('editor.reminderTomorrow'),
        icon: 'sunny-outline',
        onPress: () => setReminder(tomorrow9),
      },
      {
        label: t('editor.reminderInWeek'),
        icon: 'calendar-outline',
        onPress: () => setReminder(inWeek),
      },
    ];
    if (note.reminder_at) {
      items.push({
        label: t('editor.reminderRemove'),
        icon: 'trash-outline',
        destructive: true,
        onPress: () => {
          client
            .deleteNoteReminder(note.id)
            .then(load)
            .catch((e) => setError(describeError(e)));
        },
      });
    }
    return items;
  }, [client, note, load, t, locale]);

  const openSnapshots = useCallback(async () => {
    if (!client || !note) return;
    setSnapshots(null);
    setSnapshotsVisible(true);
    try {
      const list = await client.listSnapshots(note.id);
      setSnapshots(list);
    } catch (e) {
      setSnapshotsVisible(false);
      setError(describeError(e));
    }
  }, [client, note]);

  const handleRestoreSnapshot = useCallback(
    (snapshot: SnapshotInfo) => {
      if (!client || !note) return;
      dialog.alert(
        t('editor.snapshotRestoreTitle'),
        t('editor.snapshotRestoreMessage', {
          time: formatDateTime(snapshot.created_at || snapshot.date, locale),
        }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('editor.restore'),
            onPress: async () => {
              try {
                await client.restoreSnapshot(note.id, { snapshotKey: snapshot.snapshot_key });
                bumpDataVersion();
                setSnapshotsVisible(false);
                await load();
              } catch (e) {
                setError(describeError(e));
              }
            },
          },
        ],
      );
    },
    [client, note, load, dialog, t, locale],
  );

  const openBacklinks = useCallback(async () => {
    if (!client || !note) return;
    setBacklinks(null);
    setBacklinksVisible(true);
    try {
      const list = await client.getBacklinks(note.id);
      setBacklinks(list);
    } catch (e) {
      setBacklinksVisible(false);
      setError(describeError(e));
    }
  }, [client, note]);

  const openFolderPicker = useCallback(async () => {
    if (!client || !note) return;
    setFolderList(null);
    setFoldersVisible(true);
    try {
      const list = await client.listFolders(note.workspace ?? undefined);
      setFolderList(list);
    } catch (e) {
      setFoldersVisible(false);
      setError(describeError(e));
    }
  }, [client, note]);

  const handleMoveToFolder = useCallback(
    async (folder: Folder | null) => {
      if (!client || !note) return;
      setFoldersVisible(false);
      try {
        if (folder === null) {
          await client.removeNoteFromFolder(note.id);
        } else {
          await client.moveNoteToFolder(note.id, folder.id);
        }
        bumpDataVersion();
        await load();
      } catch (e) {
        setError(describeError(e));
      }
    },
    [client, note, load],
  );

  const handleActions = useCallback(() => {
    setActionsVisible(true);
  }, []);

  const actionItems = useCallback((): ActionSheetItem[] => {
    if (!note) return [];
    return [
      { label: t('editor.moveToFolder'), icon: 'folder-outline', onPress: openFolderPicker },
      { label: t('editor.duplicate'), icon: 'copy-outline', onPress: handleDuplicate },
      {
        label: note.type === 'markdown' ? t('editor.convertToHtml') : t('editor.convertToMarkdown'),
        icon: 'swap-horizontal-outline',
        onPress: handleConvert,
      },
      { label: t('editor.shareLink'), icon: 'link-outline', onPress: handleShare },
      {
        label: t('editor.attachments'),
        icon: 'attach-outline',
        onPress: () => setAttachmentsVisible(true),
      },
      { label: t('editor.reminder'), icon: 'alarm-outline', onPress: handleReminder },
      { label: t('editor.snapshots'), icon: 'hourglass-outline', onPress: openSnapshots },
      { label: t('editor.backlinks'), icon: 'return-down-back-outline', onPress: openBacklinks },
    ];
  }, [note, openFolderPicker, handleDuplicate, handleConvert, handleShare, handleReminder, openSnapshots, openBacklinks, t]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: '',
      headerRight: () => (
        <View style={styles.headerButtons}>
          <TouchableOpacity onPress={handleToggleFavorite} hitSlop={8} style={styles.headerButton} accessibilityLabel="favorite-note">
            <Ionicons
              name={favorite ? 'star' : 'star-outline'}
              size={22}
              color={favorite ? colors.star : colors.textFaint}
            />
          </TouchableOpacity>
          {!isTemp ? (
            <TouchableOpacity onPress={handleActions} hitSlop={8} style={styles.headerButton} accessibilityLabel="note-actions">
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.accent} />
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity onPress={handleDelete} hitSlop={8} style={styles.headerButton} accessibilityLabel="delete-note">
            <Ionicons name="trash-outline" size={22} color={colors.danger} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [
    navigation,
    note,
    favorite,
    isTemp,
    handleToggleFavorite,
    handleDelete,
    handleActions,
    styles,
    colors,
  ]);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (error && !note) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity onPress={load} style={styles.retryButton}>
          <Text style={styles.retryText}>{t('common.retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { paddingBottom: bottomPadding }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <ScrollView style={styles.flex} contentContainerStyle={styles.container}>
        <OfflineBanner />

        {lockedByOther ? (
          <View style={styles.lockBanner}>
            <Ionicons name="lock-closed" size={14} color={colors.lockBannerText} />
            <Text style={styles.lockBannerText}>{lockedByOther}</Text>
          </View>
        ) : null}

        <TextInput
          style={styles.headingInput}
          value={heading}
          onChangeText={setHeading}
          placeholder={t('editor.headingPlaceholder')}
          placeholderTextColor={colors.textFaint}
          editable={!lockedByOther}
        />

        {note ? (
          <Text style={styles.meta}>
            {[note.workspace, note.folder].filter(Boolean).join(' · ')}
            {note.type ? ` · ${note.type}` : ''}
            {note.reminder_at ? ` · ⏰ ${formatDateTime(note.reminder_at, locale)}` : ''}
          </Text>
        ) : null}

        <TextInput
          style={styles.tagsInput}
          value={tags}
          onChangeText={setTags}
          placeholder={t('editor.tagsPlaceholder')}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!lockedByOther}
        />

        <TextInput
          style={styles.contentInput}
          value={content}
          onChangeText={setContent}
          placeholder={t('editor.contentPlaceholder')}
          placeholderTextColor={colors.textFaint}
          multiline
          textAlignVertical="top"
          editable={!lockedByOther}
        />

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {isSaving ? (
          <Text style={styles.savedText}>{t('editor.saving')}</Text>
        ) : !isDirty && savedLocally ? (
          <Text style={styles.savedText}>{t('editor.savedLocally')}</Text>
        ) : !isDirty && savedAt ? (
          <Text style={styles.savedText}>{t('editor.savedAt', { time: savedAt })}</Text>
        ) : null}
      </ScrollView>

      {/* Версии (snapshots) */}
      <Modal
        visible={snapshotsVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setSnapshotsVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('editor.snapshotsTitle')}</Text>
            {snapshots === null ? (
              <ActivityIndicator color={colors.accent} style={styles.modalSpinner} />
            ) : snapshots.length === 0 ? (
              <Text style={styles.modalEmpty}>{t('editor.snapshotsEmpty')}</Text>
            ) : (
              <ScrollView style={styles.modalList}>
                {snapshots.map((s) => (
                  <TouchableOpacity
                    key={s.snapshot_key}
                    style={styles.modalItem}
                    onPress={() => handleRestoreSnapshot(s)}
                  >
                    <View style={styles.modalItemBody}>
                      <Text style={styles.modalItemTitle} numberOfLines={1}>
                        {s.heading || t('common.untitled')}
                      </Text>
                      <Text style={styles.modalItemMeta}>
                        {formatDateTime(s.created_at || s.date, locale)}
                        {s.manual ? ` · ${t('editor.snapshotManual')}` : ''}
                      </Text>
                    </View>
                    <Ionicons name="arrow-undo" size={18} color={colors.accent} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity style={styles.modalClose} onPress={() => setSnapshotsVisible(false)}>
              <Text style={styles.modalCloseText}>{t('common.close')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Выбор папки */}
      <Modal
        visible={foldersVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setFoldersVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('editor.moveToFolderTitle')}</Text>
            {folderList === null ? (
              <ActivityIndicator color={colors.accent} style={styles.modalSpinner} />
            ) : (
              <ScrollView style={styles.modalList}>
                {note?.folder ? (
                  <TouchableOpacity style={styles.modalItem} onPress={() => handleMoveToFolder(null)}>
                    <View style={styles.modalItemBody}>
                      <Text style={styles.modalItemTitle}>{t('editor.rootFolder')}</Text>
                    </View>
                    <Ionicons name="close-circle-outline" size={18} color={colors.textFaint} />
                  </TouchableOpacity>
                ) : null}
                {folderList.length === 0 && !note?.folder ? (
                  <Text style={styles.modalEmpty}>{t('editor.noFolders')}</Text>
                ) : null}
                {folderList.map((f) => (
                  <TouchableOpacity
                    key={f.id}
                    style={styles.modalItem}
                    onPress={() => handleMoveToFolder(f)}
                  >
                    <View style={styles.modalItemBody}>
                      <Text style={styles.modalItemTitle} numberOfLines={1}>
                        {f.path ?? f.name}
                      </Text>
                    </View>
                    {note?.folder_id === f.id ? (
                      <Ionicons name="checkmark" size={18} color={colors.accent} />
                    ) : (
                      <Ionicons name="folder-outline" size={18} color={colors.textFaint} />
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity style={styles.modalClose} onPress={() => setFoldersVisible(false)}>
              <Text style={styles.modalCloseText}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Обратные ссылки */}
      <Modal
        visible={backlinksVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setBacklinksVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>{t('editor.backlinksTitle')}</Text>
            {backlinks === null ? (
              <ActivityIndicator color={colors.accent} style={styles.modalSpinner} />
            ) : backlinks.length === 0 ? (
              <Text style={styles.modalEmpty}>{t('editor.backlinksEmpty')}</Text>
            ) : (
              <ScrollView style={styles.modalList}>
                {backlinks.map((b) => (
                  <TouchableOpacity
                    key={b.id}
                    style={styles.modalItem}
                    onPress={() => {
                      setBacklinksVisible(false);
                      navigation.push('NoteEditor', { noteId: b.id, favorite: 0 });
                    }}
                  >
                    <View style={styles.modalItemBody}>
                      <Text style={styles.modalItemTitle} numberOfLines={1}>
                        {b.heading || t('common.untitled')}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textFaint} />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <TouchableOpacity style={styles.modalClose} onPress={() => setBacklinksVisible(false)}>
              <Text style={styles.modalCloseText}>{t('common.close')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {client && note && !isTemp ? (
        <AttachmentsModal
          visible={attachmentsVisible}
          noteId={note.id}
          workspace={note.workspace}
          client={client}
          onClose={() => setAttachmentsVisible(false)}
        />
      ) : null}

      <ActionSheet
        visible={actionsVisible}
        title={t('editor.actions')}
        items={actionItems()}
        onClose={() => setActionsVisible(false)}
      />
      <ActionSheet
        visible={reminderVisible}
        title={t('editor.reminderTitle')}
        subtitle={note?.reminder_at ? t('editor.reminderCurrent', { time: formatDateTime(note.reminder_at, locale) }) : undefined}
        items={reminderItems()}
        onClose={() => setReminderVisible(false)}
      />
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    container: { padding: 16, paddingBottom: 48 },
    lockBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.lockBannerBg,
      borderRadius: 8,
      padding: 10,
      marginBottom: 8,
      gap: 8,
    },
    lockBannerText: { flex: 1, fontSize: 13, color: colors.lockBannerText },
    headingInput: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.text,
      paddingVertical: 8,
    },
    meta: { fontSize: 12, color: colors.textFaint, marginTop: 4 },
    tagsInput: {
      fontSize: 14,
      color: colors.accent,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      marginBottom: 8,
    },
    contentInput: {
      fontSize: 16,
      color: colors.text,
      lineHeight: 23,
      minHeight: 320,
      paddingVertical: 8,
    },
    headerButtons: { flexDirection: 'row', alignItems: 'center', marginRight: 12 },
    headerButton: { marginLeft: 18 },
    errorText: { fontSize: 14, color: colors.danger, marginTop: 12, textAlign: 'center' },
    savedText: { fontSize: 12, color: colors.textFaint, marginTop: 12 },
    retryButton: {
      marginTop: 16,
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retryText: { color: colors.accentText, fontWeight: '600' },
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: 'flex-end',
    },
    modalCard: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      padding: 20,
      maxHeight: '70%',
    },
    modalTitle: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 12 },
    modalSpinner: { marginVertical: 24 },
    modalEmpty: { fontSize: 14, color: colors.textFaint, textAlign: 'center', marginVertical: 24 },
    modalList: { flexGrow: 0 },
    modalItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    modalItemBody: { flex: 1, marginRight: 10 },
    modalItemTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
    modalItemMeta: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
    modalClose: { marginTop: 16, alignItems: 'center', paddingVertical: 10 },
    modalCloseText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
  });
