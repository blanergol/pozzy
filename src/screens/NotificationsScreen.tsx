import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
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
import { NotificationItem } from '../api/types';
import { useDialog } from '../components/DialogProvider';
import { useSettings } from '../context/SettingsContext';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { dateLocale, Locale, useI18n } from '../i18n';
import { bumpDataVersion, freshMark, isFresh, STALE_MARK } from '../utils/freshness';
import { RootStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Notifications'>;

function formatDateTime(value: string, locale: Locale): string {
  const date = new Date(value.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(dateLocale(locale), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function NotificationsScreen({ navigation }: Props) {
  const { client, workspace } = useSettings();
  const dialog = useDialog();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const { t, locale } = useI18n();

  const [items, setItems] = useState<NotificationItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastLoadRef = useRef(STALE_MARK);

  const load = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent' = 'initial') => {
      if (!client) return;
      if (mode === 'initial') setIsLoading(true);
      if (mode === 'refresh') setIsRefreshing(true);
      try {
        const list = await client.listNotifications(workspace ?? undefined);
        setItems(list);
        setError(null);
        lastLoadRef.current = freshMark();
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
      // Повторный фокус: без спиннера, а в пределах TTL — вообще без сети
      if (isFresh(lastLoadRef.current)) return;
      load(lastLoadRef.current.at === 0 ? 'initial' : 'silent');
    }, [load]),
  );

  const handleDismissAll = useCallback(() => {
    if (!client) return;
    dialog.alert(t('notif.dismissAllTitle'), undefined, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('notif.dismissAll'),
        onPress: async () => {
          try {
            await client.dismissAllNotifications();
            bumpDataVersion();
            await load('refresh');
          } catch (e) {
            setError(describeError(e));
          }
        },
      },
    ]);
  }, [client, load, dialog, t]);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: t('nav.notifications'),
      headerRight: () =>
        items.length > 0 ? (
          <TouchableOpacity onPress={handleDismissAll} hitSlop={8}>
            <Text style={styles.dismissAllText}>{t('notif.dismissAll')}</Text>
          </TouchableOpacity>
        ) : null,
    });
  }, [navigation, items.length, handleDismissAll, t]);

  const handleMarkRead = async (item: NotificationItem) => {
    if (!client) return;
    setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, is_read: 1 } : n)));
    try {
      await client.markNotificationRead(item.id);
      bumpDataVersion();
    } catch {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, is_read: 0 } : n)));
    }
  };

  const handleDismiss = async (item: NotificationItem) => {
    if (!client) return;
    const prev = items;
    setItems((cur) => cur.filter((n) => n.id !== item.id));
    try {
      await client.dismissNotification(item.id);
      bumpDataVersion();
    } catch {
      setItems(prev);
    }
  };

  const handleOpen = async (item: NotificationItem) => {
    await handleMarkRead(item);
    navigation.navigate('NoteEditor', { noteId: item.note_id, favorite: 0 });
  };

  const renderItem = ({ item }: { item: NotificationItem }) => (
    <TouchableOpacity
      style={[styles.row, !item.is_read && styles.rowUnread]}
      onPress={() => handleOpen(item)}
      activeOpacity={0.7}
    >
      <Ionicons
        name={item.type === 'reminder' ? 'alarm-outline' : 'notifications-outline'}
        size={22}
        color={item.is_read ? colors.textFaint : colors.accent}
        style={styles.rowIcon}
      />
      <View style={styles.rowBody}>
        <Text style={[styles.rowTitle, !item.is_read && styles.rowTitleUnread]} numberOfLines={2}>
          {item.message || t('notif.reminderFallback')}
        </Text>
        <Text style={styles.rowMeta}>{formatDateTime(item.trigger_at, locale)}</Text>
      </View>
      {!item.is_read ? (
        <TouchableOpacity onPress={() => handleMarkRead(item)} hitSlop={8} style={styles.rowAction}>
          <Ionicons name="checkmark-done" size={20} color={colors.accent} />
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity onPress={() => handleDismiss(item)} hitSlop={8} style={styles.rowAction}>
        <Ionicons name="close" size={20} color={colors.textFaint} />
      </TouchableOpacity>
    </TouchableOpacity>
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
        data={items}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        contentContainerStyle={items.length === 0 ? styles.emptyContainer : styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={() => load('refresh')}
            tintColor={colors.accent}
          />
        }
        ListEmptyComponent={
          <View style={styles.center}>
            <Ionicons name="notifications-off-outline" size={48} color={colors.textFaint} />
            <Text style={styles.emptyText}>{t('notif.empty')}</Text>
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
  rowUnread: { borderLeftWidth: 3, borderLeftColor: colors.accent },
  rowIcon: { marginRight: 12 },
  rowBody: { flex: 1, marginRight: 10 },
  rowTitle: { fontSize: 15, color: colors.text },
  rowTitleUnread: { fontWeight: '600' },
  rowMeta: { fontSize: 12, color: colors.textFaint, marginTop: 3 },
  rowAction: { marginLeft: 14 },
  emptyText: { marginTop: 12, fontSize: 15, color: colors.textFaint },
  dismissAllText: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  errorText: { fontSize: 14, color: colors.danger, textAlign: 'center', margin: 12 },
});
