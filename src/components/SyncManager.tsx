import { useEffect } from 'react';
import { useConnectivity } from '../context/ConnectivityContext';
import { useSettings } from '../context/SettingsContext';
import { syncNow } from '../data/sync';
import { scheduleDailyDigest, syncScheduledReminders } from '../notifications/reminders';

/**
 * Invisible component: on the offline→online transition (and on app start)
 * starts syncing the queue of local changes with the server.
 * After the sync, reschedules local notifications (reminders + digest).
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
          // the counter is not critical
        }
        await scheduleDailyDigest(profileId, unread);
      })
      .catch(() => {});
  }, [isOnline, client, activeProfile, reportSuccess, reportNetworkError]);

  return null;
}
