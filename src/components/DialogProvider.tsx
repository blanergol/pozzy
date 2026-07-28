import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useI18n } from '../i18n';

export interface DialogButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

export interface DialogOptions {
  title: string;
  message?: string;
  buttons: DialogButton[];
}

interface DialogContextValue {
  alert: (title: string, message?: string, buttons?: DialogButton[]) => void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

const DEFAULT_BUTTONS: DialogButton[] = [{ text: 'OK', style: 'cancel' }];

/**
 * Кроссплатформенная замена Alert.alert:
 * react-native-web реализует Alert как no-op, поэтому на вебе нативный Alert не работает.
 */
export function DialogProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const [dialog, setDialog] = useState<DialogOptions | null>(null);

  const alert = useCallback<DialogContextValue['alert']>((title, message, buttons) => {
    setDialog({ title, message, buttons: buttons?.length ? buttons : DEFAULT_BUTTONS });
  }, []);

  const value = useMemo(() => ({ alert }), [alert]);

  const close = () => setDialog(null);

  return (
    <DialogContext.Provider value={value}>
      {children}
      <Modal visible={dialog !== null} transparent animationType="fade" onRequestClose={close}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={close}>
          <TouchableOpacity style={styles.card} activeOpacity={1} onPress={() => {}}>
            {dialog ? (
              <>
                <Text style={styles.title}>{dialog.title}</Text>
                {dialog.message ? <Text style={styles.message}>{dialog.message}</Text> : null}
                <View style={styles.buttons}>
                  {dialog.buttons.map((button, index) => (
                    <TouchableOpacity
                      key={`${button.text}-${index}`}
                      style={styles.button}
                      onPress={() => {
                        close();
                        // даём модалке закрыться перед действием
                        setTimeout(() => button.onPress?.(), 50);
                      }}
                    >
                      <Text
                        style={[
                          styles.buttonText,
                          button.style === 'destructive' && styles.buttonDestructive,
                          button.style === 'cancel' && styles.buttonCancel,
                        ]}
                      >
                        {button.text}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </DialogContext.Provider>
  );
}

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('useDialog must be used within DialogProvider');
  return ctx;
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: colors.overlay,
      justifyContent: 'center',
      padding: 40,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 20,
      maxWidth: 400,
      alignSelf: 'center',
      width: '100%',
    },
    title: { fontSize: 17, fontWeight: '700', color: colors.text, textAlign: 'center' },
    message: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginTop: 8 },
    buttons: { marginTop: 18 },
    button: {
      paddingVertical: 12,
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.borderLight,
    },
    buttonText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
    buttonDestructive: { color: colors.danger },
    buttonCancel: { color: colors.textFaint, fontWeight: '400' },
  });
