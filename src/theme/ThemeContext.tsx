import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';

export interface ThemeColors {
  bg: string;
  card: string;
  text: string;
  textSecondary: string;
  textFaint: string;
  border: string;
  borderLight: string;
  accent: string;
  accentText: string;
  danger: string;
  star: string;
  lockBannerBg: string;
  lockBannerText: string;
  overlay: string;
  inputBg: string;
}

export const lightColors: ThemeColors = {
  bg: '#f5f6fa',
  card: '#ffffff',
  text: '#1c1c1e',
  textSecondary: '#6b6b70',
  textFaint: '#8e8e93',
  border: '#d7d7dc',
  borderLight: '#e5e5ea',
  accent: '#2f6fed',
  accentText: '#ffffff',
  danger: '#c62828',
  star: '#f5a623',
  lockBannerBg: '#fff7d6',
  lockBannerText: '#8a6d00',
  overlay: 'rgba(0,0,0,0.35)',
  inputBg: '#ffffff',
};

export const darkColors: ThemeColors = {
  bg: '#101012',
  card: '#1d1d20',
  text: '#f2f2f7',
  textSecondary: '#a5a5aa',
  textFaint: '#8e8e96',
  border: '#3a3a3f',
  borderLight: '#2c2c30',
  accent: '#5b8cff',
  accentText: '#ffffff',
  danger: '#ef5350',
  star: '#f5a623',
  lockBannerBg: '#3d3417',
  lockBannerText: '#e5c95c',
  overlay: 'rgba(0,0,0,0.6)',
  inputBg: '#232326',
};

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  isDark: boolean;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'system',
  isDark: false,
  colors: lightColors,
});

interface Props {
  mode: ThemeMode;
  children: React.ReactNode;
}

/** Палитра темы. Источник mode — SettingsContext (с персистом). */
export function ThemeProvider({ mode, children }: Props) {
  const systemScheme = useColorScheme();
  const value = useMemo<ThemeContextValue>(() => {
    const isDark = mode === 'dark' || (mode === 'system' && systemScheme === 'dark');
    return { mode, isDark, colors: isDark ? darkColors : lightColors };
  }, [mode, systemScheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/** Хелпер для экранов: мемоизированные стили по палитре. */
export function useThemedStyles<T>(factory: (colors: ThemeColors) => T, colors: ThemeColors): T {
  return useMemo(() => factory(colors), [factory, colors]);
}
