import React from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useI18n } from '../i18n';

export interface ActionSheetItem {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  title?: string;
  subtitle?: string;
  items: ActionSheetItem[];
  onClose: () => void;
}

/** Cross-platform action sheet equivalent: the Android Alert does not show more than 3 buttons. */
export default function ActionSheet({ visible, title, subtitle, items, onClose }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const { t } = useI18n();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity style={styles.card} activeOpacity={1} onPress={() => {}}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
          <ScrollView style={styles.list} bounces={false}>
            {items.map((item, index) => (
              <TouchableOpacity
                key={`${item.label}-${index}`}
                style={styles.item}
                onPress={() => {
                  onClose();
                  // let the modal close before the next action
                  setTimeout(item.onPress, 50);
                }}
              >
                {item.icon ? (
                  <Ionicons
                    name={item.icon}
                    size={20}
                    color={item.destructive ? colors.danger : colors.accent}
                    style={styles.itemIcon}
                  />
                ) : null}
                <Text style={[styles.itemLabel, item.destructive && styles.itemDestructive]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const createStyles = (colors: ThemeColors) =>
  StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
  card: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '70%',
  },
  title: { fontSize: 16, fontWeight: '700', color: colors.text, textAlign: 'center' },
  subtitle: { fontSize: 13, color: colors.textFaint, textAlign: 'center', marginTop: 4 },
  list: { flexGrow: 0, marginTop: 12 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 },
  itemIcon: { marginRight: 14, width: 24, textAlign: 'center' },
  itemLabel: { fontSize: 16, color: colors.text },
  itemDestructive: { color: colors.danger },
  cancel: {
    marginTop: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderLight,
  },
  cancelText: { fontSize: 16, color: colors.textFaint, fontWeight: '600' },
});
