import { useEffect } from 'react';
import { useSettings } from '../context/SettingsContext';
import { useI18n } from '../i18n';
import { useAppLock } from '../security/AppLock';
import { subscribeLostEdits, takeLostEdits } from '../storage/secure';
import { useDialog } from './DialogProvider';

/**
 * Невидимый компонент: если несинхронизированные офлайн-правки оказались
 * нечитаемыми (потерян ключ данных), один раз показывает пользователю
 * сообщение. Флаг переживает перезапуск, пока сообщение не показано.
 */
export default function LostEditsNotice() {
  const { profiles, isLoading } = useSettings();
  const dialog = useDialog();
  const { t } = useI18n();
  const { isReady: lockReady, locked } = useAppLock();

  useEffect(() => {
    // Ждём загрузки профилей и разблокировки: модалка не должна висеть поверх замка
    if (isLoading || !lockReady || locked) return;
    const check = async () => {
      // Флаг уже снят — показываем даже при размонтировании эффекта, иначе
      // сообщение потеряется
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
