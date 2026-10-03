import { useCallback, useEffect, useRef } from 'react';
import * as QuickActions from 'expo-quick-actions';
import { RepoContext, repoCreateNote } from '../data/notesRepository';
import { useSettings } from '../context/SettingsContext';
import { useConnectivity } from '../context/ConnectivityContext';
import { navigationRef } from '../navigation/navigationRef';
import { useI18n } from '../i18n';

/**
 * App icon quick actions (long press): new note, voice note, search.
 * No icons: on Android custom ones require assets; without them the app icon
 * is shown instead.
 */
export default function QuickActionsHandler() {
  const { client, activeProfile, workspace } = useSettings();
  const { isOnline, reportNetworkError, reportSuccess } = useConnectivity();
  const { t } = useI18n();
  const handledInitialRef = useRef(false);
  const busyRef = useRef(false);

  // Menu items; re-set when the language changes
  useEffect(() => {
    QuickActions.isSupported()
      .then((ok) => {
        if (!ok) return;
        return QuickActions.setItems([
          { id: 'new', title: t('quick.newNote') },
          { id: 'voice', title: t('quick.newVoiceNote') },
          { id: 'search', title: t('quick.search') },
        ]);
      })
      .catch(() => {});
  }, [t]);

  const handle = useCallback(
    (actionId: string) => {
      if (busyRef.current || !navigationRef.isReady()) return;
      if (actionId === 'search') {
        navigationRef.navigate('Tabs', { screen: 'Notes', params: { focusSearch: true } });
        return;
      }
      if (!client || !activeProfile) return;
      busyRef.current = true;
      const ctx: RepoContext = {
        client,
        profileId: activeProfile.id,
        isOnline,
        reportNetworkError,
        reportSuccess,
      };
      repoCreateNote(ctx, {
        heading: t('list.newNote'),
        content: '',
        workspace: workspace ?? undefined,
      })
        .then((noteId) => {
          if (navigationRef.isReady()) {
            navigationRef.navigate('NoteEditor', {
              noteId,
              favorite: 0,
              startVoice: actionId === 'voice',
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          busyRef.current = false;
        });
    },
    [client, activeProfile, workspace, isOnline, reportNetworkError, reportSuccess, t],
  );

  // Action tapped while the app is running
  useEffect(() => {
    const sub = QuickActions.addListener((action) => handle(String(action.id)));
    return () => sub.remove();
  }, [handle]);

  // Cold start from an action
  useEffect(() => {
    if (handledInitialRef.current || !client) return;
    const initial = QuickActions.initial;
    if (initial) {
      handledInitialRef.current = true;
      handle(String(initial.id));
    }
  }, [client, handle]);

  return null;
}
