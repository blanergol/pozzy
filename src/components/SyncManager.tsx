import { useEffect } from 'react';
import { useConnectivity } from '../context/ConnectivityContext';
import { useSettings } from '../context/SettingsContext';
import { syncNow } from '../data/sync';
import { scheduleDailyDigest, syncScheduledReminders } from '../notifications/reminders';

/**
 * Невидимый компонент: при переходе оффлайн→онлайн (и при старте приложения)
 * запускает синхронизацию очереди локальных изменений с сервером.
 * После синка перепланирует локальные уведомления (напоминания + дайджест).
 */
export default function SyncManager() {
  const { isOnline, reportNetworkError, reportSuccess } = useConnectivity();
  const { client, activeProfile } = useSettings();

  useEffect(() => {
    if (!isOnline || !client || !activeProfile) return;
    const profileId = activeProfile.id;
    syncNow(client, profileId, { reportSuccess, reportNetworkError })
      .then(async () => {
        await syncScheduledReminders(profileId);
        let unread = 0;
        try {
          unread = (await client.getReminderCounts()).unread_count;
        } catch {
          // счётчик не критичен
        }
        await scheduleDailyDigest(profileId, unread);
      })
      .catch(() => {});
  }, [isOnline, client, activeProfile, reportSuccess, reportNetworkError]);

  return null;
}
