import { PoznoteClient } from '../api/client';
import { NoteListItem } from '../api/types';
import { processAttachmentOps } from './attachmentQueue';
import { PendingOp, loadOfflineData, resolveNoteId, saveOfflineData } from '../storage/offlineStore';
import { bumpDataVersion } from '../utils/freshness';

function isNetworkError(e: unknown): boolean {
  return e instanceof Error && e.message === 'network';
}

/** Серверное время 'YYYY-MM-DD HH:MM:SS' или ISO → ms. Невалидное → 0. */
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
 * Синхронизация после восстановления связи.
 * Конфликты — last-write-wins по дате: серверная правка новее локальной
 * операции → локальная отбрасывается; иначе локальная уходит на сервер.
 * Возвращает число отправленных операций.
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

    // Серверный список нужен для LWW и сверки избранного
    let serverList: NoteListItem[] = [];
    try {
      serverList = await client.listNotes({ sort: 'updated_desc' });
      callbacks.reportSuccess?.();
    } catch (e) {
      if (isNetworkError(e)) callbacks.reportNetworkError?.();
      throw e;
    }

    // Обрабатываем очередь по порядку; после каждой операции сохраняемся.
    // Вложения откладываем: им нужны серверные id заметок (create-операции).
    const deferredAttachments: PendingOp[] = [];
    while (data.pending.length > 0) {
      const op = data.pending[0] as PendingOp;
      if (op.type === 'attachment') {
        deferredAttachments.push(data.pending.shift() as PendingOp);
        continue;
      }
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
          // Перепривязка временного id → серверного
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
          // в списке серверных заметок появится при финальном refetch
        } else if (op.type === 'update') {
          const serverItem = serverList.find((n) => n.id === id);
          const serverTs = toMs(serverItem?.updated);
          if (!serverItem || serverTs <= toMs(op.clientTs)) {
            // Локальная версия новее (или заметки нет в списке — пушим)
            await client.updateNote(id, {
              heading: op.payload.heading,
              content: op.payload.content,
              tags: op.payload.tags,
            });
            const details = data.notesDetails[String(id)];
            if (details) delete details.localUpdatedAt;
          }
          // иначе сервер новее — локальную правку отбрасываем (LWW)
        } else if (op.type === 'delete') {
          await client.deleteNote(id).catch((e: unknown) => {
            // заметка уже удалена на сервере — считаем операцию выполненной
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
          // связь снова пропала — останавливаемся, очередь сохранена
          data.pending.push(...deferredAttachments);
          await saveOfflineData(profileId, data);
          return pushed;
        }
        // Прочие ошибки (409/423 лок, 500 и т.п.): пропускаем операцию,
        // чтобы не блокировать очередь навсегда
      }
      data.pending.shift();
      await saveOfflineData(profileId, data);
    }

    // Отложенные вложения — после note-операций: временные id уже разрешены
    data.pending.push(...deferredAttachments);
    if (deferredAttachments.length > 0) {
      const att = await processAttachmentOps(client, profileId, data);
      pushed += att.pushed;
      if (att.networkError) {
        callbacks.reportNetworkError?.();
        return pushed;
      }
      if (att.pushed > 0) callbacks.reportSuccess?.();
    }

    // Очередь пуста — подтягиваем свежие снимки с сервера
    try {
      const [freshList, folders] = await Promise.all([
        client.listNotes({ sort: 'updated_desc' }),
        client.listFolders(),
      ]);
      data.notesList = freshList;
      data.folders = folders;
      // детали заметок подтянутся при открытии; очищаем устаревшие кэши,
      // которых уже нет на сервере
      const serverIds = new Set(freshList.map((n) => String(n.id)));
      for (const key of Object.keys(data.notesDetails)) {
        const numeric = Number(key);
        if (numeric > 0 && !serverIds.has(key)) delete data.notesDetails[key];
        if (numeric > 0 && serverIds.has(key)) delete data.notesDetails[key].localUpdatedAt;
      }
      await saveOfflineData(profileId, data);
      callbacks.reportSuccess?.();
      // кэш изменился — экраны перечитают данные при следующем фокусе
      bumpDataVersion();
    } catch (e) {
      if (isNetworkError(e)) callbacks.reportNetworkError?.();
    }

    return pushed;
  } finally {
    syncInFlight = false;
  }
}
