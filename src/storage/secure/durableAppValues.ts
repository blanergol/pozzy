import AsyncStorage from '@react-native-async-storage/async-storage';
import { APP_SCOPE, encryptedCache } from './encryptedCache';

/**
 * App-level user content that must survive a restart on all platforms
 * (note templates). On iOS/Android it goes to the encrypted cache under the
 * app key. On web there is nowhere to store the data key, and keeping templates
 * in memory only would mean losing them on every page reload, so there they
 * stay in localStorage as before (they contain no secrets; see README).
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
