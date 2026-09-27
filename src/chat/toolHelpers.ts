import { PoznoteClient } from '../api/client';
import { NoteListItem } from '../api/types';

/** Аргументы инструмента от модели (произвольный JSON-объект). */
export type ToolArgs = Record<string, unknown>;

// ===== helpers =====

export function compactNote(n: NoteListItem) {
  return {
    id: n.id,
    heading: n.heading,
    tags: n.tags,
    folder: n.folder,
    workspace: n.workspace,
    updated: n.updated,
  };
}

export function err(message: string): string {
  return JSON.stringify({ error: message });
}

export function clampLimit(value: unknown, fallback = 10): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 25);
}

/** Найти заметку: по note_id или по заголовку (через поиск). Возвращает id или строку-ошибку для модели. */
export async function resolveNoteId(client: PoznoteClient, args: ToolArgs): Promise<number | string> {
  const rawId = Number(args.note_id);
  if (Number.isFinite(rawId) && rawId > 0) return Math.floor(rawId);

  const heading = typeof args.heading === 'string' ? args.heading.trim() : '';
  if (!heading) return err('note_id or heading is required');

  const found = await client.searchNotes({ q: heading, limit: 10 });
  if (found.length === 0) return err(`note not found: ${heading}`);

  // точное совпадение заголовка предпочтительнее частичного
  const exact = found.filter((n) => n.heading.toLowerCase() === heading.toLowerCase());
  const candidates = exact.length > 0 ? exact : found;
  if (candidates.length === 1) return candidates[0].id;

  return err(
    `ambiguous heading "${heading}", candidates: ` +
      candidates.map((n) => `#${n.id} "${n.heading}"`).join('; '),
  );
}

/** Найти папку по имени. Возвращает id или строку-ошибку для модели. */
export async function resolveFolderId(
  client: PoznoteClient,
  folder: unknown,
  workspace?: string,
): Promise<number | string> {
  const rawId = Number(folder);
  if (Number.isFinite(rawId) && rawId > 0) return Math.floor(rawId);

  const name = typeof folder === 'string' ? folder.trim() : '';
  if (!name) return err('folder is required');

  const folders = await client.listFolders(workspace);
  const match = folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!match) {
    return err(`folder not found: ${name}. Available: ${folders.map((f) => f.name).join(', ')}`);
  }
  return match.id;
}

export async function resolveNoteOrError(
  client: PoznoteClient,
  args: ToolArgs,
): Promise<{ id: number } | { error: string }> {
  const resolved = await resolveNoteId(client, args);
  if (typeof resolved === 'string') return { error: resolved };
  return { id: resolved };
}

/** Поиск заметок для пакетных операций: текст + диапазон дат создания, лимит по умолчанию 50. */
export async function findByQuery(client: PoznoteClient, args: ToolArgs): Promise<NoteListItem[]> {
  const notes = await client.listNotes({
    search: typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined,
    created_from: typeof args.created_after === 'string' && args.created_after.trim() ? args.created_after.trim() : undefined,
    created_to: typeof args.created_before === 'string' && args.created_before.trim() ? args.created_before.trim() : undefined,
    sort: 'updated_desc',
  });
  const rawLimit = Number(args.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 50;
  return notes.slice(0, limit);
}

export const NOTE_REF = {
  note_id: { type: 'number', description: 'Note id (if known)' },
  heading: { type: 'string', description: 'Note title to search for (if note_id is unknown)' },
};
