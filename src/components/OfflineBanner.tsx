import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useConnectivity } from '../context/ConnectivityContext';
import { useTheme } from '../theme/ThemeContext';
import { useI18n } from '../i18n';

/** Offline-mode indicator bar. Not rendered when online. */
export default function OfflineBanner() {
  const { isOnline } = useConnectivity();
  const { colors } = useTheme();
  const { t } = useI18n();

  if (isOnline) return null;

  return (
    <View style={[styles.banner, { backgroundColor: colors.lockBannerBg }]}>
      <Ionicons name="cloud-offline-outline" size={14} color={colors.lockBannerText} />
      <Text style={[styles.text, { color: colors.lockBannerText }]}>{t('offline.banner')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 8,
    padding: 10,
    gap: 8,
  },
  text: { flex: 1, fontSize: 13 },
});
