import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
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
import { Folder, FolderCounts } from '../api/types';
import ActionSheet, { ActionSheetItem } from '../components/ActionSheet';
import OfflineBanner from '../components/OfflineBanner';
import { useDialog } from '../components/DialogProvider';
import { useSettings } from '../context/SettingsContext';
import { useConnectivity } from '../context/ConnectivityContext';
import { RepoContext, repoListFolders } from '../data/notesRepository';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useI18n } from '../i18n';
import { MainTabParamList, RootStackParamList } from '../navigation/types';

type Props = CompositeScreenProps<
  BottomTabScreenProps<MainTabParamList, 'Folders'>,
  NativeStackScreenProps<RootStackParamList>
>;

// Пагинация списка: показываем порциями, догружаем при скролле
const PAGE_SIZE = 10;

export default function FoldersScreen({ navigation }: Props) {
  const { client, workspace, activeProfile } = useSettings();
  const { isOnline, reportNetworkError, reportSuccess } = useConnectivity();
  const dialog = useDialog();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const { t } = useI18n();

  const repoCtx = useMemo<RepoContext | null>(
    () =>
      client
        ? {
            client,
            profileId: activeProfile?.id ?? null,
            isOnline,
            reportNetworkError,
            reportSuccess,
          }
        : null,
    [client, activeProfile, isOnline, reportNetworkError, reportSuccess],
  );

  const [folders, setFolders] = useState<Folder[]>([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [counts, setCounts] = useState<FolderCounts>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameModal, setNameModal] = useState<{ mode: 'create' } | { mode: 'rename'; folder: Folder } | null>(null);
  const [nameValue, setNameValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [actionsFolder, setActionsFolder] = useState<Folder | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!client || !repoCtx) return;
      if (mode === 'initial') setIsLoading(true);
      if (mode === 'refresh') setIsRefreshing(true);
      try {
        const ws = workspace ?? undefined;
        // Оффлайн — папки из локального кэша, счётчики недоступны
        const { folders: folderList, fromCache } = await repoListFolders(repoCtx, ws);
        const folderCounts = fromCache ? {} : await client.getFolderCounts(ws);
        setFolders(folderList);
        setVisibleCount(PAGE_SIZE);
        setCounts(folderCounts);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [client, repoCtx, workspace],
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Плавная догрузка следующей порции при скролле
  const handleLoadMore = useCallback(() => {
    if (isLoadingMore || visibleCount >= folders.length) return;
    setIsLoadingMore(true);
    setTimeout(() => {
      setVisibleCount((c) => c + PAGE_SIZE);
      setIsLoadingMore(false);
    }, 250);
  }, [isLoadingMore, visibleCount, folders.length]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: workspace ? t('folders.titleWorkspace', { workspace }) : t('nav.folders'),
      headerRight: () => (
        <TouchableOpacity
          onPress={() => {
            setNameValue('');
            setNameModal({ mode: 'create' });
          }}
          hitSlop={8}
          style={styles.headerButton}
          accessibilityLabel="add-folder"
        >
          <Ionicons name="add" size={26} color={colors.accent} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, workspace, t, colors]);

  const handleSaveName = async () => {
    if (!client || !nameModal) return;
    const name = nameValue.trim();
    if (!name) return;
    setIsSaving(true);
    try {
      if (nameModal.mode === 'create') {
        await client.createFolder({ name, workspace: workspace ?? undefined });
      } else {
        await client.renameFolder(nameModal.folder.id, name);
      }
      setNameModal(null);
      await load('refresh');
    } catch (e) {
      setError(describeError(e));
      setNameModal(null);
    } finally {
      setIsSaving(false);
    }
  };

  const folderActionItems = useCallback((): ActionSheetItem[] => {
    if (!client || !actionsFolder) return [];
    const folder = actionsFolder;
    return [
      {
        label: t('folders.rename'),
        icon: 'pencil-outline',
        onPress: () => {
          setNameValue(folder.name);
          setNameModal({ mode: 'rename', folder });
        },
      },
      {
        label: t('folders.emptyFolder'),
        icon: 'file-tray-outline',
        onPress: () =>
          dialog.alert(t('folders.emptyTitle'), t('folders.emptyMessage'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('folders.emptyAction'),
              style: 'destructive',
              onPress: async () => {
                try {
                  await client.emptyFolder(folder.id);
                  await load('refresh');
                } catch (e) {
                  setError(describeError(e));
                }
              },
            },
          ]),
      },
      {
        label: t('folders.deleteFolder'),
        icon: 'trash-outline',
        destructive: true,
        onPress: () =>
          dialog.alert(t('folders.deleteTitle'), folder.name, [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('common.delete'),
              style: 'destructive',
              onPress: async () => {
                try {
                  await client.deleteFolder(folder.id);
                  await load('refresh');
                } catch (e) {
                  setError(describeError(e));
                }
              },
            },
          ]),
      },
    ];
  }, [client, actionsFolder, load, dialog, t]);

  const handleFolderActions = (folder: Folder) => {
    setActionsFolder(folder);
  };

  const renderItem = ({ item }: { item: Folder }) => {
    const count = counts[String(item.id)];
    const isChild = item.parent_id !== null;
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={() =>
          navigation.navigate('FolderNotes', { folderId: item.id, folderName: item.name })
        }
        onLongPress={() => handleFolderActions(item)}
        activeOpacity={0.7}
      >
        <Ionicons
          name={isChild ? 'folder-open-outline' : 'folder-outline'}
          size={22}
          color={item.color_hex ?? colors.accent}
          style={styles.rowIcon}
        />
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {item.name}
          </Text>
          {item.path && item.path !== item.name ? (
            <Text style={styles.rowPath} numberOfLines={1}>
              {item.path}
            </Text>
          ) : null}
        </View>
        {count !== undefined ? <Text style={styles.rowCount}>{count}</Text> : null}
        <TouchableOpacity onPress={() => handleFolderActions(item)} hitSlop={8} accessibilityLabel="folder-actions">
          <Ionicons name="ellipsis-vertical" size={18} color={colors.textFaint} />
        </TouchableOpacity>
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
      <OfflineBanner />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <FlatList
        data={folders.slice(0, visibleCount)}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.3}
        ListFooterComponent={
          isLoadingMore ? (
            <ActivityIndicator style={styles.footerLoader} color={colors.accent} />
          ) : null
        }
        contentContainerStyle={folders.length === 0 ? styles.emptyContainer : styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => load('refresh')}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="folder-open-outline" size={48} color={colors.textFaint} />
            <Text style={styles.emptyText}>{t('folders.empty')}</Text>
          </View>
        }
      />

      <ActionSheet
        visible={actionsFolder !== null}
        title={actionsFolder?.name}
        items={folderActionItems()}
        onClose={() => setActionsFolder(null)}
      />

      {/* Создание/переименование папки */}
      <Modal
        visible={nameModal !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setNameModal(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              {nameModal?.mode === 'rename' ? t('folders.renameFolder') : t('folders.newFolder')}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={nameValue}
              onChangeText={setNameValue}
              placeholder={t('folders.namePlaceholder')}
              placeholderTextColor={colors.textFaint}
              autoFocus
              onSubmitEditing={handleSaveName}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity onPress={() => setNameModal(null)} style={styles.modalButton}>
                <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleSaveName}
                style={styles.modalButton}
                disabled={isSaving || !nameValue.trim()}
              >
                {isSaving ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text
                    style={[
                      styles.modalSaveText,
                      !nameValue.trim() && styles.modalSaveDisabled,
                    ]}
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
    headerButton: { marginRight: 12 },
    footerLoader: { paddingVertical: 14 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    listContent: { padding: 12 },
    emptyContainer: { flexGrow: 1, justifyContent: 'center' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 14,
      marginBottom: 8,
    },
    rowIcon: { marginRight: 12 },
    rowBody: { flex: 1, marginRight: 10 },
    rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
    rowPath: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
    rowCount: { fontSize: 14, color: colors.textFaint, marginRight: 12 },
    emptyText: { marginTop: 12, fontSize: 15, color: colors.textFaint, textAlign: 'center' },
    errorText: { fontSize: 14, color: colors.danger, textAlign: 'center', margin: 12 },
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
  });
