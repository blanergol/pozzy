import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useTheme } from '../theme/ThemeContext';

// useIsFocused падает вне навигационного контекста (unit-тесты) — тогда считаем экран видимым
function useSafeIsFocused(): boolean {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useIsFocused();
  } catch {
    return true;
  }
}

export type VoiceErrorKind = 'permission' | 'generic';

interface UseVoiceDictationOptions {
  /** Язык распознавания (BCP-47), например ru-RU. */
  lang: string;
  /** Текущий распознанный текст сессии (финальные фразы + текущий interim). */
  onTranscript: (text: string) => void;
  onError?: (kind: VoiceErrorKind) => void;
  /**
   * События обрабатываются только когда enabled=true (по умолчанию — когда экран
   * в фокусе). События модуля глобальны: без этого диктовка в редакторе
   * попадала бы и в поле ввода чата (оба экрана смонтированы одновременно).
   */
  enabled?: boolean;
}

/**
 * Диктовка: onTranscript получает весь текст текущей сессии (не дельту) —
 * потребитель сам решает, куда его подставить (поле ввода, позиция курсора).
 */
export function useVoiceDictation({ lang, onTranscript, onError, enabled }: UseVoiceDictationOptions) {
  const focused = useSafeIsFocused();
  const active = enabled ?? focused;
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const finalRef = useRef('');
  const listeningRef = useRef(false);
  const enabledRef = useRef(enabled);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  listeningRef.current = listening;
  enabledRef.current = active;
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  useEffect(() => {
    try {
      setAvailable(ExpoSpeechRecognitionModule.isRecognitionAvailable());
    } catch {
      setAvailable(false);
    }
    return () => {
      if (listeningRef.current) ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  // Экран ушёл из фокуса посреди диктовки — обрываем, чтобы не писать «в никуда»
  useEffect(() => {
    if (!active && listeningRef.current) {
      ExpoSpeechRecognitionModule.abort();
      setListening(false);
    }
  }, [active]);

  useSpeechRecognitionEvent('start', () => {
    if (enabledRef.current) setListening(true);
  });
  useSpeechRecognitionEvent('end', () => {
    if (enabledRef.current) setListening(false);
  });
  useSpeechRecognitionEvent('result', (event) => {
    if (!enabledRef.current) return;
    const transcript = event.results[0]?.transcript.trim() ?? '';
    if (event.isFinal && transcript) {
      finalRef.current = [finalRef.current, transcript].filter(Boolean).join(' ');
    }
    const interim = event.isFinal ? '' : transcript;
    onTranscriptRef.current([finalRef.current, interim].filter(Boolean).join(' '));
  });
  useSpeechRecognitionEvent('error', (event) => {
    if (!enabledRef.current) return;
    setListening(false);
    if (event.error === 'not-allowed') {
      onErrorRef.current?.('permission');
    } else if (event.error !== 'aborted' && event.error !== 'no-speech' && event.error !== 'speech-timeout') {
      onErrorRef.current?.('generic');
    }
  });

  const toggle = useCallback(async () => {
    if (listeningRef.current) {
      ExpoSpeechRecognitionModule.stop();
      return;
    }
    const perms = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perms.granted) {
      onErrorRef.current?.('permission');
      return;
    }
    Keyboard.dismiss();
    finalRef.current = '';
    ExpoSpeechRecognitionModule.start({
      lang,
      interimResults: true,
      continuous: true,
      addsPunctuation: true,
    });
  }, [lang]);

  return { available, listening, toggle };
}

interface VoiceDictationButtonProps {
  listening: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
}

export function VoiceDictationButton({
  listening,
  disabled,
  onPress,
  accessibilityLabel,
}: VoiceDictationButtonProps) {
  const { colors } = useTheme();
  return (
    <TouchableOpacity
      style={[
        styles.button,
        { backgroundColor: colors.inputBg, borderColor: colors.borderLight },
        listening && { backgroundColor: colors.danger, borderColor: colors.danger },
      ]}
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: listening }}
    >
      <Ionicons
        name={listening ? 'stop' : 'mic-outline'}
        size={20}
        color={listening ? colors.accentText : colors.textSecondary}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
});
