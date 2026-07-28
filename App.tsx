import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { SettingsProvider, useSettings } from './src/context/SettingsContext';
import { useTheme } from './src/theme/ThemeContext';
import { useI18n } from './src/i18n';
import { DialogProvider } from './src/components/DialogProvider';
import { RootStackParamList } from './src/navigation/types';
import SettingsScreen from './src/screens/SettingsScreen';
import NotesListScreen from './src/screens/NotesListScreen';
import NoteEditorScreen from './src/screens/NoteEditorScreen';
import FoldersScreen from './src/screens/FoldersScreen';
import TrashScreen from './src/screens/TrashScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

function RootNavigator() {
  const { activeProfile, isLoading } = useSettings();
  const { colors, isDark } = useTheme();
  const { t } = useI18n();

  if (isLoading) {
    return (
      <View style={[styles.splash, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <Stack.Navigator
      // Первый экран — настройки, если ни один сервер ещё не настроен
      initialRouteName={activeProfile ? 'NotesList' : 'Settings'}
      screenOptions={{
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text },
        headerStyle: { backgroundColor: colors.card },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: t('nav.settings'), headerBackVisible: !!activeProfile }}
      />
      <Stack.Screen
        name="NotesList"
        component={NotesListScreen}
        options={{ title: t('nav.notes'), headerBackVisible: false }}
      />
      <Stack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: '' }} />
      <Stack.Screen
        name="Folders"
        component={FoldersScreen}
        options={{ title: t('nav.folders') }}
      />
      <Stack.Screen name="Trash" component={TrashScreen} options={{ title: t('nav.trash') }} />
      <Stack.Screen
        name="Notifications"
        component={NotificationsScreen}
        options={{ title: t('nav.notifications') }}
      />
    </Stack.Navigator>
  );
}

function ThemedNavigation() {
  const { colors, isDark } = useTheme();

  // Фон системного окна — именно он виден под экранами во время анимации
  // переходов (react-native-screens). Без этого при тёмной теме между
  // экранами мелькает белый.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(colors.bg).catch(() => {});
  }, [colors.bg]);

  const baseTheme = isDark ? DarkTheme : DefaultTheme;
  const navTheme = {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      primary: colors.accent,
      background: colors.bg,
      card: colors.card,
      text: colors.text,
      border: colors.borderLight,
    },
  };
  return (
    <NavigationContainer theme={navTheme}>
      <DialogProvider>
        <RootNavigator />
      </DialogProvider>
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ThemedNavigation />
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
