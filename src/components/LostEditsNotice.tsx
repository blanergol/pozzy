import { useEffect } from 'react';
import { useSettings } from '../context/SettingsContext';
import { useI18n } from '../i18n';
import { useAppLock } from '../security/AppLock';
import { subscribeLostEdits, takeLostEdits } from '../storage/secure';
import { useDialog } from './DialogProvider';

/**
 * Invisible component: if unsynced offline edits turned out to be unreadable
 * (data key lost), shows the user a message once. The flag survives restarts
 * until the message has been shown.
 */
export default function LostEditsNotice() {
  const { profiles, isLoading } = useSettings();
  const dialog = useDialog();
  const { t } = useI18n();
  const { isReady: lockReady, locked } = useAppLock();

  useEffect(() => {
    // Wait for profiles to load and for unlock: the modal must not sit on top of the lock screen
    if (isLoading || !lockReady || locked) return;
    const check = async () => {
      // The flag is already cleared: show even if the effect unmounts, otherwise
      // the message would be lost
      const ids = await takeLostEdits();
      if (ids.length === 0) return;
      const names = ids
        .map((id) => profiles.find((p) => p.id === id))
        .filter((p): p is NonNullable<typeof p> => Boolean(p))
        .map((p) => `${p.username}@${p.baseUrl.replace(/^https?:\/\//, '')}`);
      dialog.alert(
        t('offline.lostEditsTitle'),
        t('offline.lostEditsMessage', { servers: names.length > 0 ? names.join(', ') : '—' }),
      );
    };
    check().catch(() => {});
    const unsubscribe = subscribeLostEdits(() => {
      check().catch(() => {});
    });
    return unsubscribe;
  }, [isLoading, lockReady, locked, profiles, dialog, t]);

  return null;
}
