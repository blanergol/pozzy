import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { SHARED_ATTACHMENT_PREFIX } from '../storage/secure/encryptedFiles';
import * as Sharing from 'expo-sharing';
import { describeError, PoznoteClient } from '../api/client';
import { Attachment } from '../api/types';
import { base64FromBytes } from '../utils/base64';
import {
  listPendingAttachments,
  queueAttachmentUpload,
  removePendingAttachment,
} from '../data/attachmentQueue';
import { useSettings } from '../context/SettingsContext';
import { useConnectivity } from '../context/ConnectivityContext';
import { PendingOp } from '../storage/offlineStore';
import { useDialog } from './DialogProvider';
import { ThemeColors, useTheme, useThemedStyles } from '../theme/ThemeContext';
import { useI18n } from '../i18n';

interface Props {
  visible: boolean;
  noteId: number;
  workspace: string | null;
  client: PoznoteClient;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || 'attachment';
}

export default function AttachmentsModal({ visible, noteId, workspace, client, onClose }: Props) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles, colors);
  const dialog = useDialog();
  const { t } = useI18n();
  const { activeProfile } = useSettings();
  const { isOnline } = useConnectivity();
  const profileId = activeProfile?.id ?? null;
  const [attachments, setAttachments] = useState<Attachment[] | null>(null);
  const [pending, setPending] = useState<PendingOp[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    if (!profileId) return;
    setPending(await listPendingAttachments(profileId, noteId));
  }, [profileId, noteId]);

  const load = useCallback(async () => {
    try {
      const list = await client.listAttachments(noteId, workspace ?? undefined);
      setAttachments(list);
      setError(null);
    } catch (e) {
      setAttachments([]);
      setError(describeError(e));
    }
  }, [client, noteId, workspace]);

  useEffect(() => {
    if (visible) {
      setAttachments(null);
      setError(null);
      load();
      loadPending();
    }
  }, [visible, load, loadPending]);

  const handleUpload = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      const file = { uri: asset.uri, name: asset.name, mimeType: asset.mimeType };
      setIsBusy(true);
      // Оффлайн — файл копируется локально и уйдёт при синхронизации
      if (!isOnline && profileId) {
        await queueAttachmentUpload(profileId, noteId, file, workspace ?? undefined);
        await loadPending();
        return;
      }
      try {
        await client.uploadAttachment(noteId, file, workspace ?? undefined);
      } catch (e) {
        // сеть пропала в момент загрузки — в очередь
        if (e instanceof Error && e.message === 'network' && profileId) {
          await queueAttachmentUpload(profileId, noteId, file, workspace ?? undefined);
          await loadPending();
          return;
        }
        throw e;
      }
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDeletePending = (op: PendingOp) => {
    dialog.alert(t('attach.deletePendingTitle'), t('attach.deletePendingMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          if (!profileId) return;
          await removePendingAttachment(profileId, op.opId);
          await loadPending();
        },
      },
    ]);
  };

  const handleOpen = async (attachment: Attachment) => {
    setIsBusy(true);
    try {
      const { data } = await client.downloadAttachment(
        noteId,
        attachment.id,
        workspace ?? undefined,
      );
      const base64 = base64FromBytes(new Uint8Array(data));
      // Открытая копия нужна системному share sheet. Шифровать её нельзя —
      // приложение-получатель читает файл как есть; удаляется при следующем старте.
      const fileUri =
        FileSystem.cacheDirectory +
        `${SHARED_ATTACHMENT_PREFIX}${noteId}_${safeFileName(attachment.original_filename)}`;
      await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: 'base64' });
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(fileUri, { mimeType: attachment.file_type });
      } else {
        dialog.alert(t('attach.fileSaved'), fileUri);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setIsBusy(false);
    }
  };

  const handleDelete = (attachment: Attachment) => {
    dialog.alert(t('attach.deleteTitle'), attachment.original_filename, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: async () => {
          setIsBusy(true);
          try {
            await client.deleteAttachment(noteId, attachment.id);
            await load();
          } catch (e) {
            setError(describeError(e));
          } finally {
            setIsBusy(false);
          }
        },
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('attach.title')}</Text>
            <TouchableOpacity onPress={handleUpload} hitSlop={8} disabled={isBusy}>
              <Ionicons name="add-circle-outline" size={26} color={isBusy ? colors.textFaint : colors.accent} />
            </TouchableOpacity>
          </View>

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {isBusy ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}

          {attachments === null ? (
            <ActivityIndicator color={colors.accent} style={styles.spinner} />
          ) : attachments.length === 0 && pending.length === 0 ? (
            <Text style={styles.emptyText}>{t('attach.empty')}</Text>
          ) : (
            <ScrollView style={styles.list}>
              {pending.map((op) => (
                <View key={op.opId} style={styles.row}>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {op.payload.fileName}
                    </Text>
                    <Text style={styles.pendingMeta}>{t('attach.pendingUpload')}</Text>
                  </View>
                  <Ionicons name="time-outline" size={18} color={colors.textFaint} />
                  <TouchableOpacity onPress={() => handleDeletePending(op)} hitSlop={8}>
                    <Ionicons name="trash-outline" size={20} color={colors.danger} />
                  </TouchableOpacity>
                </View>
              ))}
              {attachments.map((a) => (
                <View key={a.id} style={styles.row}>
                  <TouchableOpacity style={styles.rowBody} onPress={() => handleOpen(a)}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {a.original_filename}
                    </Text>
                    <Text style={styles.rowMeta}>
                      {[a.file_type, formatSize(a.file_size)].filter(Boolean).join(' · ')}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDelete(a)} hitSlop={8}>
                    <Ionicons name="trash-outline" size={20} color={colors.danger} />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>
          )}

          <TouchableOpacity style={styles.close} onPress={onClose}>
            <Text style={styles.closeText}>{t('common.close')}</Text>
          </TouchableOpacity>
        </View>
      </View>
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
    padding: 20,
    maxHeight: '70%',
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 17, fontWeight: '700', color: colors.text },
  spinner: { marginVertical: 16 },
  emptyText: { fontSize: 14, color: colors.textFaint, textAlign: 'center', marginVertical: 24 },
  errorText: { fontSize: 13, color: colors.danger, marginTop: 10, textAlign: 'center' },
  list: { flexGrow: 0, marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderLight,
  },
  rowBody: { flex: 1, marginRight: 10 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  rowMeta: { fontSize: 12, color: colors.textFaint, marginTop: 2 },
  pendingMeta: { fontSize: 12, color: colors.textFaint, marginTop: 2, fontStyle: 'italic' },
  close: { marginTop: 16, alignItems: 'center', paddingVertical: 10 },
  closeText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
});
