import React, { createContext, useContext, useMemo } from 'react';
import { getLocales } from 'expo-localization';
import { ru, TranslationKey } from './ru';
import { en } from './en';

export type { TranslationKey };

export type LanguageMode = 'system' | 'ru' | 'en';
export type Locale = 'ru' | 'en';

type Params = Record<string, string | number>;

interface I18nContextValue {
  locale: Locale;
  t: (key: TranslationKey, params?: Params) => string;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'ru',
  t: (key) => ru[key],
});

const dictionaries = { ru, en } as const;

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}

// Current locale at module level — for code outside React (API client, utilities)
let currentLocale: Locale = 'ru';

export function getCurrentLocale(): Locale {
  return currentLocale;
}

/** Translation for non-component code (describeError etc.). */
export function translate(key: TranslationKey, params?: Params): string {
  return interpolate(dictionaries[currentLocale][key] ?? key, params);
}

function resolveSystemLocale(): Locale {
  try {
    const locales = getLocales();
    const tag = locales[0]?.languageCode ?? 'en';
    return tag === 'ru' ? 'ru' : 'en';
  } catch {
    return 'en';
  }
}

export function I18nProvider({ mode, children }: { mode: LanguageMode; children: React.ReactNode }) {
  const value = useMemo<I18nContextValue>(() => {
    const locale: Locale = mode === 'system' ? resolveSystemLocale() : mode;
    currentLocale = locale;
    const dict = dictionaries[locale];
    return {
      locale,
      t: (key, params) => interpolate(dict[key] ?? key, params),
    };
  }, [mode]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** Locale for toLocaleString etc. */
export function dateLocale(locale: Locale): string {
  return locale === 'ru' ? 'ru-RU' : 'en-US';
}
