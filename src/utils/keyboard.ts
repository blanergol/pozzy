import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Bottom padding for the keyboard on Android 15+ (edge-to-edge).
 * On Android 15 the system ignores adjustResize, and KeyboardAvoidingView
 * inside react-native-screens does not receive correct insets — so the
 * padding is applied manually from keyboard events. On older Android
 * native adjustResize works and the hook returns 0.
 */
export function useAndroidKeyboardPadding(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== 'android' || Platform.Version < 35) return undefined;
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  return height;
}
