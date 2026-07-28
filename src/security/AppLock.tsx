import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuthentication from 'expo-local-authentication';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useI18n } from '../i18n';

const STORAGE_KEY = 'poznote.appLock.v1';
const RELOCK_AFTER_MS = 30_000;
const IS_NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';

interface AppLockContextValue {
  /** Включена ли блокировка приложения. */
  enabled: boolean;
  /** Загрузка настройки завершена. */
  isReady: boolean;
  /** Доступна ли биометрия/код на устройстве. */
  isAvailable: boolean;
  /** Попытаться включить блокировку. false = недоступно на устройстве. */
  enable: () => Promise<boolean>;
  disable: () => Promise<void>;
  /** Сейчас заблокировано. */
  locked: boolean;
  /** Запросить системную разблокировку (биометрия/код). */
  requestUnlock: () => Promise<void>;
}

const AppLockContext = createContext<AppLockContextValue | null>(null);

export function AppLockProvider({ children }: { children: React.ReactNode }) {
  const [enabled, setEnabled] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);
  const [locked, setLocked] = useState(false);
  const backgroundAtRef = useRef<number | null>(null);

  useEffect(() => {
    (async () => {
      let stored = false;
      try {
        stored = (await AsyncStorage.getItem(STORAGE_KEY)) === '1';
      } catch {
        stored = false;
      }
      let available = false;
      if (IS_NATIVE) {
        try {
          const [hasHardware, isEnrolled] = await Promise.all([
            LocalAuthentication.hasHardwareAsync(),
            LocalAuthentication.isEnrolledAsync(),
          ]);
          available = hasHardware && isEnrolled;
        } catch {
          available = false;
        }
      }
      setIsAvailable(available);
      const effective = stored && available && IS_NATIVE;
      setEnabled(effective);
      setLocked(effective);
      setIsReady(true);
    })();
  }, []);

  // Повторная блокировка после сворачивания
  useEffect(() => {
    if (!enabled) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        backgroundAtRef.current = Date.now();
      } else if (state === 'active') {
        const away = backgroundAtRef.current;
        backgroundAtRef.current = null;
        if (away !== null && Date.now() - away > RELOCK_AFTER_MS) {
          setLocked(true);
        }
      }
    });
    return () => sub.remove();
  }, [enabled]);

  const enable = useCallback(async (): Promise<boolean> => {
    if (!IS_NATIVE || !isAvailable) return false;
    setEnabled(true);
    setLocked(true);
    await AsyncStorage.setItem(STORAGE_KEY, '1').catch(() => {});
    return true;
  }, [isAvailable]);

  const disable = useCallback(async () => {
    setEnabled(false);
    setLocked(false);
    await AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  const requestUnlock = useCallback(async () => {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Pozzy',
        cancelLabel: '✕',
        disableDeviceFallback: false, // системный fallback на PIN/паттерн/пароль
        requireConfirmation: false,
      });
      if (result.success) setLocked(false);
    } catch {
      // системный диалог недоступен — остаёмся заблокированными
    }
  }, []);

  const value = useMemo<AppLockContextValue>(
    () => ({ enabled, isReady, isAvailable, enable, disable, locked, requestUnlock }),
    [enabled, isReady, isAvailable, enable, disable, locked, requestUnlock],
  );

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
}

export function useAppLock(): AppLockContextValue {
  const ctx = useContext(AppLockContext);
  if (!ctx) throw new Error('useAppLock must be used within AppLockProvider');
  return ctx;
}

/** Полноэкранная блокировка поверх приложения. */
export function AppLockScreen() {
  const { locked, requestUnlock } = useAppLock();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const { t } = useI18n();
  const promptedRef = useRef(false);

  useEffect(() => {
    // автозапрос системного окна один раз на каждую блокировку
    if (locked && !promptedRef.current) {
      promptedRef.current = true;
      requestUnlock();
    }
    if (!locked) promptedRef.current = false;
  }, [locked, requestUnlock]);

  if (!locked) return null;

  return (
    <View style={styles.overlay}>
      <View style={styles.iconCircle}>
        <Ionicons name="lock-closed" size={40} color={colors.accent} />
      </View>
      <Text style={styles.title}>Pozzy</Text>
      <TouchableOpacity style={styles.button} onPress={requestUnlock} activeOpacity={0.8}>
        <Ionicons name="finger-print" size={22} color={colors.accentText} />
        <Text style={styles.buttonText}>{t('lock.button')}</Text>
      </TouchableOpacity>
    </View>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.bg,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 100,
      elevation: 100,
    },
    iconCircle: {
      width: 88,
      height: 88,
      borderRadius: 44,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 20,
    },
    title: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: 32 },
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 24,
      paddingVertical: 14,
    },
    buttonText: { color: colors.accentText, fontSize: 17, fontWeight: '600' },
  });
