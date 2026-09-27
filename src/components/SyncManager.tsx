import { useEffect } from 'react';
import { useConnectivity } from '../context/ConnectivityContext';
import { useSettings } from '../context/SettingsContext';
import { syncNow } from '../data/sync';

/**
 * Невидимый компонент: при переходе оффлайн→онлайн (и при старте приложения)
 * запускает синхронизацию очереди локальных изменений с сервером.
 */
export default function SyncManager() {
  const { isOnline, reportNetworkError, reportSuccess } = useConnectivity();
  const { client, activeProfile } = useSettings();

  useEffect(() => {
    if (!isOnline || !client || !activeProfile) return;
    syncNow(client, activeProfile.id, { reportSuccess, reportNetworkError }).catch(() => {});
  }, [isOnline, client, activeProfile, reportSuccess, reportNetworkError]);

  return null;
}
