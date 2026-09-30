import AsyncStorage from '@react-native-async-storage/async-storage';
import { APP_SCOPE, encryptedCache } from './encryptedCache';

/**
 * Пользовательский контент приложения, который должен переживать перезапуск
 * на всех платформах (шаблоны заметок). На iOS/Android — зашифрованный кэш
 * с ключом приложения. На web ключ данных негде хранить, а держать шаблоны
 * только в памяти значит терять их при каждой перезагрузке страницы, поэтому
 * там они остаются в localStorage как раньше (секретов в них нет; см. README).
 */
export const durableAppValues = {
  get(key: string): Promise<string | null> {
    return encryptedCache.persistent ? encryptedCache.get(APP_SCOPE, key) : AsyncStorage.getItem(key);
  },
  set(key: string, value: string): Promise<void> {
    return encryptedCache.persistent
      ? encryptedCache.set(APP_SCOPE, key, value)
      : AsyncStorage.setItem(key, value);
  },
};
