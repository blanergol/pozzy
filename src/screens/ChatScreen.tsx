import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BottomTabScreenProps, useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { ChatError } from '../api/chat';
import { runAgent } from '../chat/agent';
import { buildMemoryContext } from '../chat/memory';
import MarkdownText from '../components/MarkdownText';
import { useDialog } from '../components/DialogProvider';
import { clearChatHistory, loadChatHistory, saveChatHistory } from '../storage/chatHistory';
import { useSettings } from '../context/SettingsContext';
import { MainTabParamList } from '../navigation/types';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useAndroidKeyboardPadding } from '../utils/keyboard';
import { dateLocale, TranslationKey, useI18n } from '../i18n';

type Props = BottomTabScreenProps<MainTabParamList, 'Chat'>;

interface UiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

interface PendingApproval {
  preview: string;
  resolve: (approved: boolean) => void;
}

// Длинные ответы ассистента схлопываются с кнопкой «показать полностью»
const COLLAPSE_THRESHOLD = 600;
const COLLAPSE_PREVIEW = 400;

let nextId = 1;
function makeId(): string {
  return String(nextId++);
}

export default function ChatScreen({ navigation }: Props) {
  const { aiSettings, client } = useSettings();
  const { colors } = useTheme();
  const { t, locale } = useI18n();
  const styles = useThemedStyles(createStyles, colors);
  const keyboardPadding = useAndroidKeyboardPadding();
  // Клавиатура перекрывает таб-бар — вычитаем его высоту, но возвращаем
  // системный инсет: endCoordinates.height его уже не включает.
  const tabBarHeight = useBottomTabBarHeight();
  const bottomInset = useSafeAreaInsets().bottom;
  const bottomPadding = Math.max(0, keyboardPadding - tabBarHeight + bottomInset);

  const isConfigured = aiSettings.apiKey.trim().length > 0;

  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const approvalRef = useRef<PendingApproval | null>(null);
  approvalRef.current = pendingApproval;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialog = useDialog();

  // Голосовой ввод
  const [listening, setListening] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  // Текст, набранный до старта диктовки — распознанное дописывается к нему
  const voiceBaseTextRef = useRef('');
  const voiceFinalRef = useRef('');
  const listeningRef = useRef(false);
  listeningRef.current = listening;

  useEffect(() => {
    try {
      setVoiceAvailable(ExpoSpeechRecognitionModule.isRecognitionAvailable());
    } catch {
      setVoiceAvailable(false);
    }
    return () => {
      if (listeningRef.current) ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript.trim() ?? '';
    if (event.isFinal && transcript) {
      voiceFinalRef.current = [voiceFinalRef.current, transcript].filter(Boolean).join(' ');
    }
    const interim = event.isFinal ? '' : transcript;
    setInput([voiceBaseTextRef.current, voiceFinalRef.current, interim].filter(Boolean).join(' '));
  });
  useSpeechRecognitionEvent('error', (event) => {
    setListening(false);
    if (event.error === 'not-allowed') {
      setError(t('chat.voicePermission'));
    } else if (event.error !== 'aborted' && event.error !== 'no-speech' && event.error !== 'speech-timeout') {
      setError(t('chat.voiceError'));
    }
  });

  const handleVoicePress = useCallback(async () => {
    if (listeningRef.current) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    setError(null);
    const perms = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perms.granted) {
      setError(t('chat.voicePermission'));
      return;
    }
    Keyboard.dismiss();
    voiceBaseTextRef.current = input.trim();
    voiceFinalRef.current = '';
    ExpoSpeechRecognitionModule.start({
      lang: dateLocale(locale),
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
    });
  }, [input, locale, t]);

  // Восстановление истории при запуске
  useEffect(() => {
    loadChatHistory().then((stored) => {
      if (stored.length > 0) {
        nextId = Math.max(...stored.map((m) => Number(m.id) || 0)) + 1;
        setMessages(stored);
      }
    });
  }, []);

  // Персист истории (с дебаунсом, чтобы не писать на каждое изменение)
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveChatHistory(messages).catch(() => {});
    }, 400);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [messages]);

  const handleClearChat = useCallback(() => {
    dialog.alert(t('chat.clearTitle'), t('chat.clearMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          setMessages([]);
          clearChatHistory().catch(() => {});
        },
      },
    ]);
  }, [dialog, t]);

  useLayoutEffect(() => {
    if (!isConfigured) return;
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          onPress={handleClearChat}
          hitSlop={8}
          style={styles.headerButton}
          accessibilityLabel={t('chat.clear')}
        >
          <Ionicons name="trash-outline" size={22} color={colors.accent} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, handleClearChat, isConfigured, styles, colors, t]);

  const describeChatError = useCallback(
    (err: unknown): string => {
      if (err instanceof ChatError) {
        if (err.message === 'network') return t('chat.errorNetwork');
        if (err.message === 'empty') return t('chat.errorEmpty');
        if (err.status === 401 || err.status === 403) return t('chat.errorAuth');
        return t('chat.errorServer', { status: err.status ?? '?', message: err.message });
      }
      return t('chat.errorNetwork');
    },
    [t],
  );

  const requestApproval = useCallback(
    ({ preview }: { toolName: string; preview: string }) =>
      new Promise<boolean>((resolve) => {
        setPendingApproval({ preview, resolve });
      }),
    [],
  );

  const resolveApproval = useCallback((approved: boolean) => {
    approvalRef.current?.resolve(approved);
    setPendingApproval(null);
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    if (!client) {
      setError(t('chat.noServer'));
      return;
    }
    if (listeningRef.current) ExpoSpeechRecognitionModule.stop();
    setInput('');
    setError(null);
    const userMessage: UiMessage = { id: makeId(), role: 'user', content: text };
    const history = [...messages, userMessage];
    setMessages(history);
    setSending(true);
    try {
      const fullHistory = history
        .filter((m) => m.role !== 'tool')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      // короткая память — последние сообщения; длинная — саммари старых
      const memory = await buildMemoryContext(aiSettings, fullHistory);
      const reply = await runAgent(aiSettings, client, memory.history, {
        onTool: (toolName) =>
          setMessages((prev) => [...prev, { id: makeId(), role: 'tool', content: toolName }]),
        requestApproval,
      }, memory.summary);
      if (reply.trim()) {
        setMessages((prev) => [...prev, { id: makeId(), role: 'assistant', content: reply }]);
      }
    } catch (err) {
      setError(describeChatError(err));
    } finally {
      setSending(false);
    }
  }, [input, sending, messages, aiSettings, client, t, describeChatError, requestApproval]);

  if (!isConfigured) {
    return (
      <View style={styles.center}>
        <Ionicons name="chatbubble-ellipses-outline" size={48} color={colors.textFaint} />
        <Text style={styles.emptyTitle}>{t('chat.notConfigured')}</Text>
        <Text style={styles.emptyHint}>{t('chat.notConfiguredHint')}</Text>
        <TouchableOpacity
          style={styles.settingsButton}
          onPress={() => navigation.getParent()?.navigate('Settings')}
          accessibilityLabel={t('chat.openSettings')}
        >
          <Text style={styles.settingsButtonText}>{t('chat.openSettings')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.flex, { paddingBottom: bottomPadding }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {messages.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="chatbubble-ellipses-outline" size={48} color={colors.textFaint} />
          <Text style={styles.emptyTitle}>{t('chat.empty')}</Text>
          <Text style={styles.emptyHint}>{t('chat.emptyHint')}</Text>
        </View>
      ) : (
        <FlatList
          style={styles.flex}
          contentContainerStyle={styles.listContent}
          data={[...messages].reverse()}
          keyExtractor={(item) => item.id}
          inverted
          renderItem={({ item }) => {
            if (item.role === 'tool') {
              return (
                <View style={styles.toolChip}>
                  <Ionicons name="construct-outline" size={13} color={colors.textFaint} />
                  <Text style={styles.toolChipText}>
                    {t(`chat.tool.${item.content}` as TranslationKey)}
                  </Text>
                </View>
              );
            }
            return (
              <View style={[styles.bubble, item.role === 'user' ? styles.bubbleUser : styles.bubbleAssistant]}>
                {item.role === 'assistant' ? (
                  <>
                    <MarkdownText
                      text={
                        item.content.length > COLLAPSE_THRESHOLD && !expandedIds.has(item.id)
                          ? `${item.content.slice(0, COLLAPSE_PREVIEW)}…`
                          : item.content
                      }
                      colors={colors}
                      style={styles.bubbleAssistantText}
                    />
                    {item.content.length > COLLAPSE_THRESHOLD ? (
                      <TouchableOpacity
                        onPress={() =>
                          setExpandedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                      >
                        <Text style={styles.expandToggle}>
                          {expandedIds.has(item.id) ? t('chat.showLess') : t('chat.showMore')}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </>
                ) : (
                  <Text style={styles.bubbleUserText}>{item.content}</Text>
                )}
              </View>
            );
          }}
        />
      )}
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      {pendingApproval ? (
        <View style={styles.approvalCard}>
          <Text style={styles.approvalTitle}>{t('chat.approvalTitle')}</Text>
          <Text style={styles.approvalText}>{pendingApproval.preview}</Text>
          <View style={styles.approvalButtons}>
            <TouchableOpacity
              style={[styles.approvalButton, styles.approvalReject]}
              onPress={() => resolveApproval(false)}
              accessibilityLabel={t('chat.reject')}
            >
              <Text style={styles.approvalRejectText}>{t('chat.reject')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.approvalButton, styles.approvalApprove]}
              onPress={() => resolveApproval(true)}
              accessibilityLabel={t('chat.approve')}
            >
              <Text style={styles.approvalApproveText}>{t('chat.approve')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={listening ? t('chat.voiceListening') : t('chat.placeholder')}
          placeholderTextColor={colors.textFaint}
          multiline
          onSubmitEditing={handleSend}
        />
        {voiceAvailable ? (
          <TouchableOpacity
            style={[styles.micButton, listening && styles.micButtonActive]}
            onPress={handleVoicePress}
            disabled={sending}
            accessibilityLabel={t(listening ? 'chat.voiceStop' : 'chat.voiceStart')}
            accessibilityState={{ selected: listening }}
          >
            <Ionicons
              name={listening ? 'stop' : 'mic-outline'}
              size={20}
              color={listening ? colors.accentText : colors.textSecondary}
            />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={[styles.sendButton, (!input.trim() || sending) && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || sending}
          accessibilityLabel={t('chat.send')}
        >
          {sending ? (
            <ActivityIndicator size="small" color={colors.accentText} />
          ) : (
            <Ionicons name="send" size={18} color={colors.accentText} />
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    flex: { flex: 1, backgroundColor: colors.bg },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      backgroundColor: colors.bg,
    },
    emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '600', marginTop: 16 },
    emptyHint: {
      color: colors.textSecondary,
      fontSize: 14,
      marginTop: 8,
      textAlign: 'center',
    },
    settingsButton: {
      marginTop: 20,
      backgroundColor: colors.accent,
      borderRadius: 10,
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    settingsButtonText: { color: colors.accentText, fontSize: 15, fontWeight: '600' },
    listContent: { padding: 12, flexGrow: 1 },
    bubble: {
      maxWidth: '82%',
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginVertical: 4,
    },
    bubbleUser: {
      alignSelf: 'flex-end',
      backgroundColor: colors.accent,
      borderBottomRightRadius: 4,
    },
    bubbleAssistant: {
      alignSelf: 'flex-start',
      backgroundColor: colors.card,
      borderBottomLeftRadius: 4,
    },
    bubbleUserText: { color: colors.accentText, fontSize: 15 },
    bubbleAssistantText: { color: colors.text, fontSize: 15 },
    expandToggle: { color: colors.accent, fontSize: 13, marginTop: 6, fontWeight: '600' },
    toolChip: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginVertical: 2,
      borderRadius: 999,
      backgroundColor: colors.inputBg,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    toolChipText: { color: colors.textFaint, fontSize: 12 },
    errorBanner: {
      backgroundColor: colors.danger,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    errorText: { color: '#ffffff', fontSize: 13 },
    headerButton: { marginRight: 12 },
    approvalCard: {
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    approvalTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
    approvalText: { color: colors.textSecondary, fontSize: 14, marginTop: 4 },
    approvalButtons: { flexDirection: 'row', gap: 10, marginTop: 12 },
    approvalButton: {
      flex: 1,
      alignItems: 'center',
      borderRadius: 10,
      paddingVertical: 10,
    },
    approvalApprove: { backgroundColor: colors.accent },
    approvalApproveText: { color: colors.accentText, fontSize: 14, fontWeight: '600' },
    approvalReject: { backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.border },
    approvalRejectText: { color: colors.text, fontSize: 14, fontWeight: '600' },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      padding: 10,
      gap: 10,
      backgroundColor: colors.card,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    input: {
      flex: 1,
      backgroundColor: colors.inputBg,
      color: colors.text,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.borderLight,
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 10,
      maxHeight: 120,
      fontSize: 15,
    },
    sendButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendButtonDisabled: { opacity: 0.5 },
    micButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.inputBg,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    micButtonActive: {
      backgroundColor: colors.danger,
      borderColor: colors.danger,
    },
  });
