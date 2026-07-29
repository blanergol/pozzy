import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { CompositeScreenProps, useFocusEffect } from '@react-navigation/native';
import { describeError } from '../api/client';
import ActionSheet, { ActionSheetItem } from '../components/ActionSheet';
import { useDialog } from '../components/DialogProvider';
import { useSettings } from '../context/SettingsContext';
import { NoteListItem, Workspace } from '../api/types';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { dateLocale, Locale, useI18n } from '../i18n';
import { MainTabParamList, RootStackParamList } from '../navigation/types';

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Notes'>,
  NativeStackScreenProps<RootStackParamList>
>;

function formatDate(value: string, locale: Locale): string {
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

// Пагинация списка: показываем порциями, догружаем при скролле
const PAGE_SIZE = 10;

export default function NotesListScreen({ navigation, route }: Props) {
  const { client, workspace, setWorkspace } = useSettings();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const dialog = useDialog();
  const { t, locale } = useI18n();
  const folderId = route.params?.folderId;
  const folderName = route.params?.folderName;

  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsModalVisible, setWsModalVisible] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  // Управление пространствами: ActionSheet и модалка ввода имени
  const [wsActions, setWsActions] = useState<Workspace | null>(null);
  const [wsNameModal, setWsNameModal] = useState<
    { mode: 'create' } | { mode: 'rename'; workspace: Workspace } | null
  >(null);
  const [wsNameValue, setWsNameValue] = useState('');
  const [wsSaving, setWsSaving] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  /** null = обычный режим; Set = режим выбора с отмеченными id */
  const [selection, setSelection] = useState<Set<number> | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadUnreadCount = useCallback(async () => {
    if (!client) return;
    try {
      const counts = await client.getReminderCounts(workspace ?? undefined);
      setUnreadCount(counts.unread_count);
    } catch {
      // счётчик не критичен — молча игнорируем
    }
  }, [client, workspace]);

  const load = useCallback(
    async (query: string, mode: 'initial' | 'refresh' | 'silent' = 'initial') => {
      if (!client) return;
      if (mode === 'initial') setIsLoading(true);
      if (mode === 'refresh') setIsRefreshing(true);
      try {
        const list = await client.listNotes({
          search: query.trim() || undefined,
          sort: 'updated_desc',
          workspace: workspace ?? undefined,
          folder_id: folderId,
        });
        setNotes(list);
        setVisibleCount(PAGE_SIZE);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [client, workspace, folderId],
  );

  useFocusEffect(
    useCallback(() => {
      load(search, 'silent');
      loadUnreadCount();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load, loadUnreadCount]),
  );

  // Плавная догрузка следующей порции при скролле
  const handleLoadMore = useCallback(() => {
    if (isLoadingMore || visibleCount >= notes.length) return;
    setIsLoadingMore(true);
    setTimeout(() => {
      setVisibleCount((c) => c + PAGE_SIZE);
      setIsLoadingMore(false);
    }, 250);
  }, [isLoadingMore, visibleCount, notes.length]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(search, 'silent'), 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, load]);

  const openWorkspaceSwitcher = useCallback(async () => {
    if (!client) return;
    setWsModalVisible(true);
    try {
      const list = await client.listWorkspaces();
      setWorkspaces(list);
    } catch (e) {
      setWsModalVisible(false);
      setError(describeError(e));
    }
  }, [client]);

  const handleSaveWorkspace = useCallback(async () => {
    if (!client || !wsNameModal) return;
    const name = wsNameValue.trim();
    if (!name) return;
    setWsSaving(true);
    try {
      if (wsNameModal.mode === 'create') {
        await client.createWorkspace(name);
      } else {
        const oldName = wsNameModal.workspace.name;
        await client.renameWorkspace(oldName, name);
        if (workspace === oldName) setWorkspace(name);
      }
      setWorkspaces(await client.listWorkspaces());
      setWsNameModal(null);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setWsSaving(false);
    }
  }, [client, wsNameModal, wsNameValue, workspace, setWorkspace]);

  const handleDeleteWorkspace = useCallback(
    (w: Workspace) => {
      if (!client) return;
      dialog.alert(t('list.workspaceDeleteTitle', { name: w.name }), t('list.workspaceDeleteMessage'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await client.deleteWorkspace(w.name);
              if (workspace === w.name) setWorkspace(null);
              setWorkspaces(await client.listWorkspaces());
            } catch (e) {
              setError(describeError(e));
            }
          },
        },
      ]);
    },
    [client, dialog, t, workspace, setWorkspace],
  );

  const wsActionItems = useCallback((): ActionSheetItem[] => {
    if (!wsActions) return [];
    const w = wsActions;
    return [
      {
        label: t('list.workspaceRename'),
        icon: 'pencil-outline',
        onPress: () => {
          setWsNameValue(w.name);
          setWsNameModal({ mode: 'rename', workspace: w });
        },
      },
      {
        label: t('list.workspaceDelete'),
        icon: 'trash-outline',
        destructive: true,
        onPress: () => handleDeleteWorkspace(w),
      },
    ];
  }, [wsActions, t, handleDeleteWorkspace]);

  // ===== Режим выбора (массовое удаление) =====

  const toggleSelect = useCallback((id: number) => {
    setSelection((prev) => {
      if (prev === null) return prev;
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelection((prev) => {
      if (prev === null) return prev;
      if (prev.size === notes.length) return new Set();
      return new Set(notes.map((n) => n.id));
    });
  }, [notes]);

  const handleDeleteSelected = useCallback(() => {
    if (!client || !selection || selection.size === 0) return;
    const ids = Array.from(selection);
    dialog.alert(
      t('list.deleteSelectedTitle', { count: ids.length }),
      t('list.deleteSelectedMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: async () => {
            setIsDeleting(true);
            try {
              const results = await Promise.allSettled(ids.map((id) => client.deleteNote(id)));
              const failed = results.filter((r) => r.status === 'rejected').length;
              if (failed > 0) {
                setError(t('list.deleteFailed', { failed, total: ids.length }));
              }
              setSelection(null);
              await load(search, 'refresh');
            } finally {
              setIsDeleting(false);
            }
          },
        },
      ],
    );
  }, [client, selection, load, search, dialog, t]);

  const allSelected = selection !== null && notes.length > 0 && selection.size === notes.length;

  useLayoutEffect(() => {
    if (selection !== null) {
      navigation.setOptions({
        title: t('list.selected', { count: selection.size }),
        headerLeft: () => (
          <TouchableOpacity
            onPress={() => setSelection(null)}
            hitSlop={8}
            style={styles.headerLeftButton}
            accessibilityLabel={t('list.a11yCancelSelection')}
          >
            <Ionicons name="close" size={24} color={colors.accent} />
          </TouchableOpacity>
        ),
        headerRight: () => (
          <View style={styles.headerButtons}>
            <TouchableOpacity
              onPress={toggleSelectAll}
              hitSlop={8}
              style={styles.headerButton}
              accessibilityLabel={t('list.a11ySelectAll')}
            >
              <Ionicons
                name={allSelected ? 'checkbox' : 'square-outline'}
                size={22}
                color={colors.accent}
              />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleDeleteSelected}
              hitSlop={8}
              style={styles.headerButton}
              disabled={selection.size === 0 || isDeleting}
              accessibilityLabel={t('list.a11yDeleteSelected')}
            >
              {isDeleting ? (
                <ActivityIndicator size="small" color={colors.danger} />
              ) : (
                <Ionicons
                  name="trash-outline"
                  size={22}
                  color={selection.size > 0 ? colors.danger : colors.textFaint}
                />
              )}
            </TouchableOpacity>
          </View>
        ),
      });
      return;
    }

    navigation.setOptions({
      title: folderName ?? (workspace ? t('list.titleWorkspace', { workspace }) : t('nav.notes')),
      headerLeft: undefined,
      headerRight: () => (
        <View style={styles.headerButtons}>
          <TouchableOpacity
            onPress={() => navigation.navigate('Notifications')}
            hitSlop={8}
            style={styles.headerButton}
            accessibilityLabel={t('list.a11yNotifications')}
          >
            <View>
              <Ionicons name="notifications-outline" size={22} color={colors.accent} />
              {unreadCount > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
                </View>
              ) : null}
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={openWorkspaceSwitcher}
            hitSlop={8}
            style={styles.headerButton}
            accessibilityLabel={t('list.a11yWorkspaces')}
          >
            <Ionicons
              name="albums-outline"
              size={22}
              color={workspace ? colors.star : colors.accent}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('Trash')}
            hitSlop={8}
            style={styles.headerButton}
            accessibilityLabel={t('list.a11yTrash')}
          >
            <Ionicons name="trash-outline" size={22} color={colors.accent} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('Settings')}
            hitSlop={8}
            style={styles.headerButton}
            accessibilityLabel={t('list.a11ySettings')}
          >
            <Ionicons name="settings-outline" size={22} color={colors.accent} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [
    navigation,
    folderName,
    workspace,
    unreadCount,
    openWorkspaceSwitcher,
    styles,
    colors,
    selection,
    allSelected,
    isDeleting,
    toggleSelectAll,
    handleDeleteSelected,
    t,
  ]);

  const handleCreate = async () => {
    if (!client) return;
    try {
      const id = await client.createNote({
        heading: t('list.newNote'),
        content: '',
        workspace: workspace ?? undefined,
        folder_id: folderId,
      });
      navigation.navigate('NoteEditor', { noteId: id, favorite: 0 });
    } catch (e) {
      setError(describeError(e));
    }
  };

  const handleToggleFavorite = async (note: NoteListItem) => {
    if (!client) return;
    // Оптимистичное обновление
    setNotes((prev) =>
      prev.map((n) => (n.id === note.id ? { ...n, favorite: n.favorite ? 0 : 1 } : n)),
    );
    try {
      await client.toggleFavorite(note.id);
    } catch {
      setNotes((prev) =>
        prev.map((n) => (n.id === note.id ? { ...n, favorite: note.favorite } : n)),
      );
    }
  };

  const renderItem = ({ item }: { item: NoteListItem }) => {
    const inSelection = selection !== null;
    const isSelected = selection?.has(item.id) ?? false;
    return (
      <TouchableOpacity
        style={[styles.card, isSelected && styles.cardSelected]}
        onPress={() => {
          if (inSelection) {
            toggleSelect(item.id);
          } else {
            navigation.navigate('NoteEditor', { noteId: item.id, favorite: item.favorite });
          }
        }}
        onLongPress={() => {
          if (!inSelection) setSelection(new Set([item.id]));
        }}
        delayLongPress={300}
        activeOpacity={0.7}
      >
        {inSelection ? (
          <Ionicons
            name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
            size={24}
            color={isSelected ? colors.accent : colors.textFaint}
            style={styles.cardCheckbox}
          />
        ) : null}
        <View style={styles.cardBody}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.heading || t('common.untitled')}
          </Text>
          {item.tags ? (
            <Text style={styles.cardTags} numberOfLines={1}>
              {item.tags}
            </Text>
          ) : null}
          <View style={styles.cardMeta}>
            {item.folder ? <Text style={styles.cardMetaText}>{item.folder}</Text> : null}
            {item.workspace ? <Text style={styles.cardMetaText}>{item.workspace}</Text> : null}
            <Text style={styles.cardMetaText}>{formatDate(item.updated, locale)}</Text>
          </View>
        </View>
        {!inSelection ? (
          <TouchableOpacity
            onPress={() => handleToggleFavorite(item)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Ionicons
              name={item.favorite ? 'star' : 'star-outline'}
              size={22}
              color={item.favorite ? colors.star : colors.textFaint}
            />
          </TouchableOpacity>
        ) : null}
      </TouchableOpacity>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={colors.textFaint} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder={t('list.search')}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
        />
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={() => load(search)} style={styles.retryButton}>
            <Text style={styles.retryText}>{t('common.retry')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => navigation.navigate('Settings')}>
            <Text style={styles.resetText}>{t('list.openSettings')}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={notes.slice(0, visibleCount)}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          ListFooterComponent={
            isLoadingMore ? (
              <ActivityIndicator style={styles.footerLoader} color={colors.accent} />
            ) : null
          }
          contentContainerStyle={notes.length === 0 ? styles.emptyContainer : styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isRefreshing}
              onRefresh={() => load(search, 'refresh')}
              tintColor={colors.accent}
            />
          }
          ListEmptyComponent={
            <View style={styles.center}>
              <Ionicons name="document-text-outline" size={48} color={colors.textFaint} />
              <Text style={styles.emptyText}>
                {search ? t('list.emptySearch') : t('list.empty')}
              </Text>
            </View>
          }
        />
      )}

      {selection === null ? (
        <TouchableOpacity style={styles.fab} onPress={handleCreate} activeOpacity={0.8}>
          <Ionicons name="add" size={30} color={colors.accentText} />
        </TouchableOpacity>
      ) : null}

      {/* Переключатель пространства */}
      <Modal
        visible={wsModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setWsModalVisible(false)}
      >
        <TouchableOpacity
          style={styles.wsOverlay}
          activeOpacity={1}
          onPress={() => setWsModalVisible(false)}
        >
          <View style={styles.wsCard}>
            <View style={styles.wsTitleRow}>
              <Text style={styles.wsTitle}>{t('list.workspace')}</Text>
              <TouchableOpacity
                onPress={() => {
                  setWsNameValue('');
                  setWsNameModal({ mode: 'create' });
                }}
                hitSlop={8}
                accessibilityLabel={t('list.workspaceNew')}
              >
                <Ionicons name="add" size={24} color={colors.accent} />
              </TouchableOpacity>
            </View>
            {workspaces === null ? (
              <ActivityIndicator color={colors.accent} style={styles.wsSpinner} />
            ) : (
              <>
                <TouchableOpacity
                  style={styles.wsRow}
                  onPress={() => {
                    setWorkspace(null);
                    setWsModalVisible(false);
                  }}
                >
                  <Text style={styles.wsRowText}>{t('list.workspaceAll')}</Text>
                  {workspace === null ? (
                    <Ionicons name="checkmark" size={18} color={colors.accent} />
                  ) : null}
                </TouchableOpacity>
                {workspaces.map((w) => (
                  <View key={w.name} style={styles.wsRow}>
                    <TouchableOpacity
                      style={styles.wsRowMain}
                      onPress={() => {
                        setWorkspace(w.name);
                        setWsModalVisible(false);
                      }}
                    >
                      <Text style={styles.wsRowText}>{w.name}</Text>
                      {workspace === w.name ? (
                        <Ionicons name="checkmark" size={18} color={colors.accent} />
                      ) : null}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        // закрываем свитчер: иначе ActionSheet и диалоги
                        // уходят под модалку (на web ломаются клики)
                        setWsModalVisible(false);
                        setWsActions(w);
                      }}
                      hitSlop={8}
                      accessibilityLabel={t('list.workspaceEdit')}
                    >
                      <Ionicons name="ellipsis-vertical" size={16} color={colors.textFaint} />
                    </TouchableOpacity>
                  </View>
                ))}
              </>
            )}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Действия с пространством */}
      <ActionSheet
        visible={wsActions !== null}
        title={wsActions?.name}
        items={wsActionItems()}
        onClose={() => setWsActions(null)}
      />

      {/* Создание/переименование пространства */}
      <Modal
        visible={wsNameModal !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setWsNameModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {wsNameModal?.mode === 'rename' ? t('list.workspaceRename') : t('list.workspaceNew')}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={wsNameValue}
              onChangeText={setWsNameValue}
              placeholder={t('list.workspaceNamePlaceholder')}
              placeholderTextColor={colors.textFaint}
              autoFocus
              onSubmitEditing={handleSaveWorkspace}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => setWsNameModal(null)} style={styles.modalButton}>
                <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSaveWorkspace}
                style={styles.modalButton}
                disabled={wsSaving || !wsNameValue.trim()}
              >
                {wsSaving ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text
                    style={[styles.modalSaveText, !wsNameValue.trim() && styles.modalSaveDisabled]}
                  >
                    {t('common.save')}
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.inputBg,
      margin: 12,
      marginBottom: 4,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 10,
    },
    searchIcon: { marginRight: 6 },
    searchInput: { flex: 1, paddingVertical: 10, fontSize: 16, color: colors.text },
    listContent: { padding: 12, paddingTop: 8, paddingBottom: 96 },
    emptyContainer: { flexGrow: 1, justifyContent: 'center', padding: 12 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 14,
      marginBottom: 10,
    },
    cardSelected: {
      borderWidth: 1,
      borderColor: colors.accent,
    },
    cardCheckbox: { marginRight: 12 },
    headerLeftButton: { marginRight: 4 },
    cardBody: { flex: 1, marginRight: 10 },
    cardTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
    cardTags: { fontSize: 12, color: colors.accent, marginTop: 4 },
    cardMeta: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8, gap: 8 },
    cardMetaText: { fontSize: 11, color: colors.textFaint },
    emptyText: { marginTop: 12, fontSize: 15, color: colors.textFaint },
    errorBox: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    errorText: { fontSize: 15, color: colors.danger, textAlign: 'center' },
    retryButton: {
      marginTop: 16,
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    retryText: { color: colors.accentText, fontWeight: '600' },
    resetText: { marginTop: 14, color: colors.accent, fontSize: 14 },
    headerButtons: { flexDirection: 'row', alignItems: 'center', marginRight: 12 },
    footerLoader: { paddingVertical: 14 },
    headerButton: { marginLeft: 18 },
    badge: {
      position: 'absolute',
      top: -5,
      right: -7,
      backgroundColor: colors.danger,
      borderRadius: 8,
      minWidth: 16,
      height: 16,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 3,
    },
    badgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
    wsOverlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: 'center',
      padding: 40,
    },
    wsCard: { backgroundColor: colors.card, borderRadius: 14, padding: 16 },
    wsTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    wsTitle: { fontSize: 15, fontWeight: '700', color: colors.text },
    wsSpinner: { marginVertical: 16 },
    wsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.borderLight,
    },
    wsRowMain: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    wsRowText: { fontSize: 16, color: colors.text },
    modalOverlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: 'center',
      padding: 32,
    },
    modalCard: { backgroundColor: colors.card, borderRadius: 14, padding: 20 },
    modalTitle: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 14 },
    modalInput: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: colors.text,
    },
    modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 18, gap: 20 },
    modalButton: { paddingVertical: 6, paddingHorizontal: 4 },
    modalCancelText: { fontSize: 16, color: colors.textFaint },
    modalSaveText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
    modalSaveDisabled: { opacity: 0.4 },
    fab: {
      position: 'absolute',
      right: 20,
      bottom: 28,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
      elevation: 4,
    },
  });
