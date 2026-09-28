import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useTheme } from '../theme/ThemeContext';

export type VoiceErrorKind = 'permission' | 'generic';

interface UseVoiceDictationOptions {
  /** Язык распознавания (BCP-47), например ru-RU. */
  lang: string;
  /** Текущий распознанный текст сессии (финальные фразы + текущий interim). */
  onTranscript: (text: string) => void;
  onError?: (kind: VoiceErrorKind) => void;
}

/**
 * Диктовка: onTranscript получает весь текст текущей сессии (не дельту) —
 * потребитель сам решает, куда его подставить (поле ввода, позиция курсора).
 */
export function useVoiceDictation({ lang, onTranscript, onError }: UseVoiceDictationOptions) {
  const [available, setAvailable] = useState(false);
  const [listening, setListening] = useState(false);
  const finalRef = useRef('');
  const listeningRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  listeningRef.current = listening;
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

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript.trim() ?? '';
    if (event.isFinal && transcript) {
      finalRef.current = [finalRef.current, transcript].filter(Boolean).join(' ');
    }
    const interim = event.isFinal ? '' : transcript;
    onTranscriptRef.current([finalRef.current, interim].filter(Boolean).join(' '));
  });
  useSpeechRecognitionEvent('error', (event) => {
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
