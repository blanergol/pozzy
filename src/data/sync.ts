import { PoznoteClient } from '../api/client';
import { NoteListItem } from '../api/types';
import { processAttachmentOps } from './attachmentQueue';
import { loadOfflineData, resolveNoteId, saveOfflineData } from '../storage/offlineStore';
import { bumpDataVersion } from '../utils/freshness';

function isNetworkError(e: unknown): boolean {
  return e instanceof Error && e.message === 'network';
}

/** Server time 'YYYY-MM-DD HH:MM:SS' or ISO → ms. Invalid → 0. */
function toMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value.replace(' ', 'T')).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

let syncInFlight = false;

export function isSyncing(): boolean {
  return syncInFlight;
}

/**
 * Sync after the connection is restored.
 * Conflicts are resolved last-write-wins by date: a server edit newer than the local
 * operation → the local one is discarded; otherwise the local one is pushed to the server.
 * Returns the number of operations pushed.
 */
export async function syncNow(
  client: PoznoteClient,
  profileId: string,
  callbacks: { reportSuccess?: () => void; reportNetworkError?: () => void } = {},
): Promise<number> {
  if (syncInFlight) return 0;
  syncInFlight = true;
  try {
    const data = await loadOfflineData(profileId);
    let pushed = 0;

    // The server list is needed for LWW and for reconciling favorites
    let serverList: NoteListItem[] = [];
    try {
      serverList = await client.listNotes({ sort: 'updated_desc' });
      callbacks.reportSuccess?.();
    } catch (e) {
      if (isNetworkError(e)) callbacks.reportNetworkError?.();
      throw e;
    }

    // Process the queue in order, saving after each operation.
    // Attachments are deferred: they need server note ids (from create operations).
    // They stay in the queue (and therefore on disk) — previously they were pulled out
    // of the queue for the duration of the loop, and an app crash mid-sync lost them.
    const done = new Set<string>();
    for (;;) {
      const op = data.pending.find((o) => o.type !== 'attachment' && !done.has(o.opId));
      if (!op) break;
      done.add(op.opId);
      const id = resolveNoteId(data, op.noteId);
      try {
        if (op.type === 'create') {
          const realId = await client.createNote({
            heading: op.payload.heading ?? '',
            content: op.payload.content ?? '',
            tags: op.payload.tags,
            workspace: op.payload.workspace,
            folder_id: op.payload.folder_id ?? null,
          });
          // Remap the temporary id → server id
          data.aliases[String(id)] = realId;
          const details = data.notesDetails[String(id)];
          if (details) {
            details.id = realId;
            delete details.localUpdatedAt;
            data.notesDetails[String(realId)] = details;
            delete data.notesDetails[String(id)];
          }
          const item = data.notesList.find((n) => n.id === id);
          if (item) item.id = realId;
          // it will appear in the server notes list on the final refetch
        } else if (op.type === 'update') {
          const serverItem = serverList.find((n) => n.id === id);
          const serverTs = toMs(serverItem?.updated);
          if (!serverItem || serverTs <= toMs(op.clientTs)) {
            // The local version is newer (or the note is not in the list — push)
            await client.updateNote(id, {
              heading: op.payload.heading,
              content: op.payload.content,
              tags: op.payload.tags,
            });
            const details = data.notesDetails[String(id)];
            if (details) delete details.localUpdatedAt;
          }
          // otherwise the server is newer — discard the local edit (LWW)
        } else if (op.type === 'delete') {
          await client.deleteNote(id).catch((e: unknown) => {
            // the note is already deleted on the server — treat the operation as done
            if (e instanceof Error && 'status' in e && (e as { status: number }).status === 404) return;
            throw e;
          });
        } else if (op.type === 'favorite') {
          const serverItem = serverList.find((n) => n.id === id);
          const target = op.payload.favorite ?? 0;
          if (serverItem && Number(serverItem.favorite) !== target) {
            await client.toggleFavorite(id);
          }
        }
        callbacks.reportSuccess?.();
        pushed++;
      } catch (e) {
        if (isNetworkError(e)) {
          callbacks.reportNetworkError?.();
          // connection dropped again — stop, the queue is saved
          await saveOfflineData(profileId, data);
          return pushed;
        }
        // Other errors (423 lock, 409 conflict, 500, etc.): skip the operation
        // so it doesn't block the queue forever
      }
      data.pending = data.pending.filter((o) => o.opId !== op.opId);
      await saveOfflineData(profileId, data);
    }

    // Deferred attachments go after the note operations: temporary ids are resolved by now
    if (data.pending.some((o) => o.type === 'attachment')) {
      const att = await processAttachmentOps(client, profileId, data);
      pushed += att.pushed;
      if (att.networkError) {
        callbacks.reportNetworkError?.();
        return pushed;
      }
      if (att.pushed > 0) callbacks.reportSuccess?.();
    }

    // The queue is empty — pull fresh snapshots from the server
    try {
      const [freshList, folders] = await Promise.all([
        client.listNotes({ sort: 'updated_desc' }),
        client.listFolders(),
      ]);
      data.notesList = freshList;
      data.folders = folders;
      // note details are fetched on open; purge stale cache entries
      // that no longer exist on the server
      const serverIds = new Set(freshList.map((n) => String(n.id)));
      for (const key of Object.keys(data.notesDetails)) {
        const numeric = Number(key);
        if (numeric > 0 && !serverIds.has(key)) delete data.notesDetails[key];
        if (numeric > 0 && serverIds.has(key)) delete data.notesDetails[key].localUpdatedAt;
      }
      await saveOfflineData(profileId, data);
      callbacks.reportSuccess?.();
      // the cache has changed — screens will re-read data on their next focus
      bumpDataVersion();
    } catch (e) {
      if (isNetworkError(e)) callbacks.reportNetworkError?.();
    }

    return pushed;
  } finally {
    syncInFlight = false;
  }
}
