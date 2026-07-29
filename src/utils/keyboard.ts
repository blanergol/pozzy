import { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

/**
 * Отступ снизу под клавиатуру для Android 15+ (edge-to-edge).
 * На Android 15 adjustResize игнорируется системой, а KeyboardAvoidingView
 * внутри react-native-screens не получает корректные инсеты — поэтому
 * отступ применяем вручную по событиям клавиатуры. На старых Android
 * работает нативный adjustResize, хук возвращает 0.
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
