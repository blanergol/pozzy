import React, { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { ShareIntentProvider } from 'expo-share-intent';
import { SettingsProvider, useSettings } from './src/context/SettingsContext';
import { ConnectivityProvider } from './src/context/ConnectivityContext';
import { useTheme } from './src/theme/ThemeContext';
import { useI18n } from './src/i18n';
import { DialogProvider } from './src/components/DialogProvider';
import SyncManager from './src/components/SyncManager';
import LostEditsNotice from './src/components/LostEditsNotice';
import ShareIntentHandler from './src/components/ShareIntentHandler';
import QuickActionsHandler from './src/components/QuickActionsHandler';
import { AppLockProvider, AppLockScreen } from './src/security/AppLock';
import { MainTabParamList, RootStackParamList } from './src/navigation/types';
import { navigationRef } from './src/navigation/navigationRef';
import { initNotifications } from './src/notifications/reminders';
import SettingsScreen from './src/screens/SettingsScreen';
import NotesListScreen from './src/screens/NotesListScreen';
import NoteEditorScreen from './src/screens/NoteEditorScreen';
import OnboardingScreen from './src/screens/OnboardingScreen';
import FoldersScreen from './src/screens/FoldersScreen';
import ChatScreen from './src/screens/ChatScreen';
import TrashScreen from './src/screens/TrashScreen';
import NotificationsScreen from './src/screens/NotificationsScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

// NotesListScreen используется и как вкладка (Notes), и как стек-экран
// открытой папки (FolderNotes) — параметры маршрутов совпадают.
const FolderNotesComponent = NotesListScreen as unknown as React.ComponentType<
  import('@react-navigation/native-stack').NativeStackScreenProps<RootStackParamList, 'FolderNotes'>
>;

function MainTabs() {
  const { colors } = useTheme();
  const { t } = useI18n();
  const { aiSettings } = useSettings();

  return (
    <Tab.Navigator
      screenOptions={{
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text },
        headerStyle: { backgroundColor: colors.card },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.borderLight },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tab.Screen
        name="Notes"
        component={NotesListScreen}
        options={{
          title: t('nav.notes'),
          tabBarAccessibilityLabel: t('nav.notes'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="document-text-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="Folders"
        component={FoldersScreen}
        options={{
          title: t('nav.folders'),
          tabBarAccessibilityLabel: t('nav.folders'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="folder-outline" size={size} color={color} />
          ),
        }}
      />
      {aiSettings.enabled ? (
        <Tab.Screen
          name="Chat"
          component={ChatScreen}
          options={{
            title: t('nav.chat'),
            tabBarAccessibilityLabel: t('nav.chat'),
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="chatbubble-ellipses-outline" size={size} color={color} />
            ),
          }}
        />
      ) : null}
    </Tab.Navigator>
  );
}

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
      initialRouteName={activeProfile ? 'Tabs' : 'Settings'}
      screenOptions={{
        headerTintColor: colors.accent,
        headerTitleStyle: { color: colors.text },
        headerStyle: { backgroundColor: colors.card },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="Tabs" component={MainTabs} options={{ headerShown: false }} />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: t('nav.settings'), headerBackVisible: !!activeProfile }}
      />
      <Stack.Screen name="NoteEditor" component={NoteEditorScreen} options={{ title: '' }} />
      <Stack.Screen name="FolderNotes" component={FolderNotesComponent} options={{ title: '' }} />
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

  // Локальные уведомления: handler показа, Android-канал, тап → заметка
  useEffect(() => {
    initNotifications();
  }, []);

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
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      <DialogProvider>
        <AppLockProvider>
          <SyncManager />
          <LostEditsNotice />
          <ShareIntentHandler />
          <QuickActionsHandler />
          <RootNavigator />
          <AppLockScreen />
        </AppLockProvider>
      </DialogProvider>
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

function Root() {
  const { onboardingSeen, isLoading, completeOnboarding } = useSettings();
  const { colors } = useTheme();

  if (isLoading) {
    return (
      <View style={[styles.splash, { backgroundColor: colors.bg }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  // Онбординг — один раз при первом запуске, до настроек сервера
  if (!onboardingSeen) {
    return (
      <>
        <OnboardingScreen onFinish={completeOnboarding} />
        <StatusBar style="light" />
      </>
    );
  }

  return <ThemedNavigation />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ConnectivityProvider>
          <ShareIntentProvider>
            <Root />
          </ShareIntentProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
