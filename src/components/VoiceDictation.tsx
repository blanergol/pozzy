import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useIsFocused } from '@react-navigation/native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';
import { useTheme } from '../theme/ThemeContext';

// useIsFocused throws outside a navigation context (unit tests); treat the screen as visible then
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
  /** Recognition language (BCP-47), e.g. ru-RU. */
  lang: string;
  /** Current recognized text of the session (final phrases + current interim). */
  onTranscript: (text: string) => void;
  onError?: (kind: VoiceErrorKind) => void;
  /**
   * Events are handled only when enabled=true (by default, when the screen is
   * focused). Module events are global: without this, dictation in the editor
   * would also land in the chat input (both screens are mounted at the same time).
   */
  enabled?: boolean;
}

/**
 * Dictation: onTranscript receives the whole text of the current session (not a delta);
 * the consumer decides where to put it (input field, cursor position).
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

  // Screen lost focus mid-dictation: abort so we don't write "into the void"
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
