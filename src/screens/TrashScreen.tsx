import React, { useCallback, useLayoutEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { describeError } from '../api/client';
import { TrashedNote } from '../api/types';
import { useDialog } from '../components/DialogProvider';
import { useSettings } from '../context/SettingsContext';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { dateLocale, Locale, useI18n } from '../i18n';
import { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Trash'>;

function formatDate(value: string, locale: Locale): string {
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(dateLocale(locale), { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function TrashScreen({ navigation }: Props) {
  const { client, workspace } = useSettings();
  const dialog = useDialog();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const { t, locale } = useI18n();

  const [notes, setNotes] = useState<TrashedNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (!client) return;
      if (mode === 'initial') setIsLoading(true);
      if (mode === 'refresh') setIsRefreshing(true);
      try {
        const list = await client.listTrash(workspace ?? undefined);
        setNotes(list);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      } finally {
        setIsLoading(false);
        setIsRefreshing(false);
      }
    },
    [client, workspace],
  );

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const handleEmptyTrash = useCallback(() => {
    if (!client) return;
    dialog.alert(t('trash.emptyTitle'), t('trash.emptyMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('trash.deleteAll'),
        style: 'destructive',
        onPress: async () => {
          try {
            await client.emptyTrash(workspace ?? undefined);
            await load('refresh');
          } catch (e) {
            setError(describeError(e));
          }
        },
      },
    ]);
  }, [client, workspace, load, dialog, t]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: t('nav.trash'),
      headerRight: () =>
        notes.length > 0 ? (
          <TouchableOpacity onPress={handleEmptyTrash} hitSlop={8}>
            <Text style={styles.emptyAllText}>{t('trash.emptyAll')}</Text>
          </TouchableOpacity>
        ) : null,
    });
  }, [navigation, notes.length, handleEmptyTrash, t]);

  const handleRestore = (note: TrashedNote) => {
    if (!client) return;
    dialog.alert(t('trash.restoreTitle'), note.heading, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('trash.restore'),
        onPress: async () => {
          try {
            await client.restoreNote(note.id);
            await load('refresh');
          } catch (e) {
            setError(describeError(e));
          }
        },
      },
    ]);
  };

  const handleDeletePermanent = (note: TrashedNote) => {
    if (!client) return;
    dialog.alert(t('trash.deleteTitle'), t('trash.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          try {
            await client.deleteFromTrash(note.id);
            await load('refresh');
          } catch (e) {
            setError(describeError(e));
          }
        },
      },
    ]);
  };

  const renderItem = ({ item }: { item: TrashedNote }) => (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.heading || t('common.untitled')}
        </Text>
        <Text style={styles.rowMeta}>
          {[item.workspace, item.folder].filter(Boolean).join(' · ')}
          {` · ${formatDate(item.updated, locale)}`}
        </Text>
      </View>
      <TouchableOpacity onPress={() => handleRestore(item)} hitSlop={8} style={styles.rowAction} accessibilityLabel="restore-note">
        <Ionicons name="arrow-undo" size={20} color={colors.accent} />
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => handleDeletePermanent(item)}
        hitSlop={8}
        style={styles.rowAction}
      >
        <Ionicons name="trash-outline" size={20} color={colors.danger} />
      </TouchableOpacity>
    </View>
  );

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      <FlatList
        data={notes}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={notes.length === 0 ? styles.emptyContainer : styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => load('refresh')}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="trash-bin-outline" size={48} color={colors.textFaint} />
            <Text style={styles.emptyText}>{t('trash.empty')}</Text>
          </View>
        }
      />
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
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
    rowBody: { flex: 1, marginRight: 10 },
    rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
    rowMeta: { fontSize: 12, color: colors.textFaint, marginTop: 3 },
    rowAction: { marginLeft: 16 },
    emptyText: { marginTop: 12, fontSize: 15, color: colors.textFaint },
    emptyAllText: { fontSize: 15, color: colors.danger, fontWeight: '600' },
    errorText: { fontSize: 14, color: colors.danger, textAlign: 'center', margin: 12 },
  });
