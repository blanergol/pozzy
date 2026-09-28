import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { loadOfflineData } from '../storage/offlineStore';
import { navigationRef } from '../navigation/navigationRef';
import { translate } from '../i18n';

const CHANNEL_ID = 'reminders';
const DIGEST_ID = 'daily-digest';
const DIGEST_HOUR = 9;
const noteReminderId = (noteId: number) => `note-reminder-${noteId}`;

let permissionAsked = false;

/** Одноразовая инициализация: handler показа, Android-канал, обработка тапов. */
export function initNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.HIGH,
    }).catch(() => {});
  }
  Notifications.addNotificationResponseReceivedListener((response) => {
    const noteId = response.notification.request.content.data?.noteId;
    if (typeof noteId === 'number' && navigationRef.isReady()) {
      navigationRef.navigate('NoteEditor', { noteId, favorite: 0 });
    }
  });
}

async function ensurePermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (permissionAsked) return false;
    permissionAsked = true;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}

/** Поставить/переставить локальное уведомление о напоминании заметки. */
export async function scheduleNoteReminder(
  noteId: number,
  heading: string,
  reminderAt: string,
): Promise<void> {
  const when = new Date(reminderAt.replace(' ', 'T'));
  await Notifications.cancelScheduledNotificationAsync(noteReminderId(noteId)).catch(() => {});
  if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) return;
  if (!(await ensurePermission())) return;
  await Notifications.scheduleNotificationAsync({
    identifier: noteReminderId(noteId),
    content: {
      title: heading || translate('common.untitled'),
      body: translate('notif.reminderBody'),
      sound: true,
      data: { noteId },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when, channelId: CHANNEL_ID },
  }).catch(() => {});
}

export async function cancelNoteReminder(noteId: number): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(noteReminderId(noteId)).catch(() => {});
}

/**
 * Перепланировать все напоминания из локального кэша (вызывается после синка).
 * Сервер отдаёт только сработавшие уведомления, поэтому источник истины для
 * будущих — reminder_at в кэшированных заметках; уведомления, которых больше
 * нет в кэше (или они в прошлом), снимаем.
 */
export async function syncScheduledReminders(profileId: string): Promise<void> {
  if (!(await ensurePermission())) return;
  const data = await loadOfflineData(profileId);
  const now = Date.now();
  const wanted = new Map<string, { heading: string; reminderAt: string }>();
  for (const note of Object.values(data.notesDetails)) {
    if (!note.reminder_at) continue;
    const when = new Date(note.reminder_at.replace(' ', 'T'));
    if (Number.isNaN(when.getTime()) || when.getTime() <= now) continue;
    wanted.set(noteReminderId(note.id), { heading: note.heading, reminderAt: note.reminder_at });
  }
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  for (const n of scheduled) {
    if (n.identifier.startsWith('note-reminder-') && !wanted.has(n.identifier)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
    }
  }
  for (const [id, info] of wanted) {
    const noteId = Number(id.replace('note-reminder-', ''));
    await scheduleNoteReminder(noteId, info.heading, info.reminderAt);
  }
}

/**
 * Ежедневный дайджест на 9:00: напоминания сегодня (из кэша) + непрочитанные.
 * Перепланируется при каждом синке, чтобы числа были свежими. Если сегодня
 * ничего нет — дайджест не ставим.
 */
export async function scheduleDailyDigest(profileId: string, unreadCount: number): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(DIGEST_ID).catch(() => {});
  if (!(await ensurePermission())) return;
  const data = await loadOfflineData(profileId);
  const now = new Date();
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  let today = 0;
  for (const note of Object.values(data.notesDetails)) {
    if (!note.reminder_at) continue;
    const when = new Date(note.reminder_at.replace(' ', 'T'));
    if (when.getTime() >= now.getTime() && when.getTime() <= endOfDay.getTime()) today++;
  }
  if (today === 0 && unreadCount === 0) return;
  const next = new Date(now);
  next.setHours(DIGEST_HOUR, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  await Notifications.scheduleNotificationAsync({
    identifier: DIGEST_ID,
    content: {
      title: translate('notif.digestTitle'),
      body: translate('notif.digestBody', { today, unread: unreadCount }),
      data: {},
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: next, channelId: CHANNEL_ID },
  }).catch(() => {});
}
