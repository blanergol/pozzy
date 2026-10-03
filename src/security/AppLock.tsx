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
  /** Whether app lock is enabled. */
  enabled: boolean;
  /** The setting has finished loading. */
  isReady: boolean;
  /** Whether biometrics/passcode is available on the device. */
  isAvailable: boolean;
  /** Try to enable the lock. false = not available on the device. */
  enable: () => Promise<boolean>;
  disable: () => Promise<void>;
  /** Currently locked. */
  locked: boolean;
  /** Request system unlock (biometrics/passcode). */
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

  // Re-lock after backgrounding
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
        disableDeviceFallback: false, // system fallback to PIN/pattern/password
        requireConfirmation: false,
      });
      if (result.success) setLocked(false);
    } catch {
      // system dialog unavailable: stay locked
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

/** Full-screen lock overlay on top of the app. */
export function AppLockScreen() {
  const { locked, requestUnlock } = useAppLock();
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const { t } = useI18n();
  const promptedRef = useRef(false);

  useEffect(() => {
    // auto-prompt the system dialog once per lock
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
