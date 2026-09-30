import AsyncStorage from '@react-native-async-storage/async-storage';
import { CacheBackend } from './types';

export const cacheBackend: CacheBackend = {
  persistent: true,
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
  multiGet: (keys) => AsyncStorage.multiGet(keys),
  multiSet: (pairs) => AsyncStorage.multiSet(pairs),
  multiRemove: (keys) => AsyncStorage.multiRemove(keys),
  getAllKeys: () => AsyncStorage.getAllKeys(),
};
