import { useEffect, useRef } from 'react';
import { ShareIntent, useShareIntent } from 'expo-share-intent';
import { RepoContext, repoCreateNote } from '../data/notesRepository';
import { queueAttachmentUpload } from '../data/attachmentQueue';
import { useSettings } from '../context/SettingsContext';
import { useConnectivity } from '../context/ConnectivityContext';
import { navigationRef } from '../navigation/navigationRef';
import { fetchPageTitle } from '../utils/pageTitle';
import { translate } from '../i18n';

function headingFromText(text: string): string {
  const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  return firstLine.slice(0, 80) || translate('list.newNote');
}

/** Заметка из поделившихся текстом/ссылкой/файлами. Возвращает id заметки. */
async function createSharedNote(
  ctx: RepoContext,
  shareIntent: ShareIntent,
  workspace: string | undefined,
): Promise<number | null> {
  const text = (shareIntent.webUrl ?? shareIntent.text ?? '').trim();
  const files = shareIntent.files ?? [];
  if (!text && files.length === 0) return null;

  let heading: string;
  let content: string;
  const isUrl = /^https?:\/\/\S+$/.test(text);
  if (isUrl) {
    // Заголовок страницы: сначала meta.title из интента, затем <title> страницы
    heading =
      shareIntent.meta?.title?.trim() || (await fetchPageTitle(text)) || text;
    content = text;
  } else if (text) {
    heading = shareIntent.meta?.title?.trim() || headingFromText(text);
    content = text;
  } else {
    // только файлы
    heading = `${translate('share.filesNote')} ${new Date().toLocaleDateString()}`;
    content = '';
  }

  const noteId = await repoCreateNote(ctx, { heading, content, workspace, type: 'markdown' });

  for (const file of files) {
    const upload = { uri: file.path, name: file.fileName, mimeType: file.mimeType };
    if (ctx.isOnline && noteId > 0) {
      try {
        await ctx.client.uploadAttachment(noteId, upload, workspace);
        continue;
      } catch (e) {
        if (!(e instanceof Error && e.message === 'network')) continue;
        // сеть пропала — в оффлайн-очередь
      }
    }
    if (ctx.profileId) {
      await queueAttachmentUpload(ctx.profileId, noteId, upload, workspace).catch(() => {});
    }
  }
  return noteId;
}

/**
 * Невидимый компонент: обрабатывает «Поделиться в Pozzy» — создаёт заметку
 * из текста/ссылки/файлов и открывает её в редакторе.
 */
export default function ShareIntentHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const { client, activeProfile, workspace } = useSettings();
  const { isOnline, reportNetworkError, reportSuccess } = useConnectivity();
  const busyRef = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || busyRef.current) return;
    if (!client || !activeProfile || !navigationRef.isReady()) return;
    busyRef.current = true;
    const ctx: RepoContext = {
      client,
      profileId: activeProfile.id,
      isOnline,
      reportNetworkError,
      reportSuccess,
    };
    createSharedNote(ctx, shareIntent, workspace ?? undefined)
      .then((noteId) => {
        if (noteId !== null && navigationRef.isReady()) {
          navigationRef.navigate('NoteEditor', { noteId, favorite: 0 });
        }
      })
      .catch(() => {})
      .finally(() => {
        busyRef.current = false;
        resetShareIntent();
      });
  }, [hasShareIntent, shareIntent, client, activeProfile, workspace, isOnline, reportNetworkError, reportSuccess, resetShareIntent]);

  return null;
}
