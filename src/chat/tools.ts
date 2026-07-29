import { PoznoteClient } from '../api/client';
import { ChatToolSpec } from '../api/chat';
import { NoteListItem } from '../api/types';
import { translate } from '../i18n';

/** Инструмент агента: спецификация для модели + исполнитель поверх Poznote API. */
export interface PoznoteTool {
  spec: ChatToolSpec;
  /** true — перед выполнением требуется подтверждение пользователя. */
  requiresApproval?: boolean;
  /** Текст для карточки подтверждения (вызывается до run). */
  approvalPreview?: (client: PoznoteClient, args: ToolArgs) => Promise<string>;
  run: (client: PoznoteClient, args: ToolArgs) => Promise<string>;
}

type ToolArgs = Record<string, unknown>;

// ===== helpers =====

function compactNote(n: NoteListItem) {
  return {
    id: n.id,
    heading: n.heading,
    tags: n.tags,
    folder: n.folder,
    workspace: n.workspace,
    updated: n.updated,
  };
}

function err(message: string): string {
  return JSON.stringify({ error: message });
}

function clampLimit(value: unknown, fallback = 10): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 25);
}

/** Найти заметку: по note_id или по заголовку (через поиск). Возвращает id или строку-ошибку для модели. */
async function resolveNoteId(client: PoznoteClient, args: ToolArgs): Promise<number | string> {
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
async function resolveFolderId(client: PoznoteClient, folder: unknown, workspace?: string): Promise<number | string> {
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

async function resolveNoteOrError(client: PoznoteClient, args: ToolArgs): Promise<{ id: number } | { error: string }> {
  const resolved = await resolveNoteId(client, args);
  if (typeof resolved === 'string') return { error: resolved };
  return { id: resolved };
}

/** Поиск заметок для пакетных операций: текст + диапазон дат создания, лимит по умолчанию 50. */
async function findByQuery(client: PoznoteClient, args: ToolArgs): Promise<NoteListItem[]> {
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

const NOTE_REF = {
  note_id: { type: 'number', description: 'Note id (if known)' },
  heading: { type: 'string', description: 'Note title to search for (if note_id is unknown)' },
};

// ===== tools =====

export const POZNOTE_TOOLS: PoznoteTool[] = [
  {
    spec: {
      name: 'search_notes',
      description: 'Search notes by text. Returns a compact list (id, heading, tags, folder, updated) without note contents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text (empty = list all)' },
          folder: { type: 'string', description: 'Filter by folder name' },
          workspace: { type: 'string', description: 'Filter by workspace name' },
          limit: { type: 'number', description: 'Max results (default 10, max 25)' },
        },
      },
    },
    run: async (client, args) => {
      const notes = await client.listNotes({
        search: typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined,
        folder: typeof args.folder === 'string' && args.folder.trim() ? args.folder.trim() : undefined,
        workspace: typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined,
        sort: 'updated_desc',
      });
      const limit = clampLimit(args.limit);
      return JSON.stringify(notes.slice(0, limit).map(compactNote));
    },
  },
  {
    spec: {
      name: 'get_note',
      description: 'Get the full content of a note by id or title.',
      parameters: { type: 'object', properties: { ...NOTE_REF } },
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const note = await client.getNote(resolved.id);
      return JSON.stringify({
        id: note.id,
        heading: note.heading,
        tags: note.tags,
        folder: note.folder,
        workspace: note.workspace,
        updated: note.updated,
        content: note.content,
      });
    },
  },
  {
    spec: {
      name: 'get_recent_notes',
      description: 'List recently updated notes (compact, without contents).',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 10, max 25)' },
          workspace: { type: 'string', description: 'Filter by workspace name' },
        },
      },
    },
    run: async (client, args) => {
      const notes = await client.listNotes({
        sort: 'updated_desc',
        workspace: typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined,
      });
      return JSON.stringify(notes.slice(0, clampLimit(args.limit)).map(compactNote));
    },
  },
  {
    spec: {
      name: 'list_folders',
      description: 'List folders with note counts.',
      parameters: {
        type: 'object',
        properties: { workspace: { type: 'string', description: 'Filter by workspace name' } },
      },
    },
    run: async (client, args) => {
      const workspace = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined;
      const [folders, counts] = await Promise.all([
        client.listFolders(workspace),
        client.getFolderCounts(workspace),
      ]);
      return JSON.stringify(
        folders.map((f) => ({
          id: f.id,
          name: f.name,
          notes: Number(counts[String(f.id)] ?? 0),
        })),
      );
    },
  },
  {
    spec: {
      name: 'list_workspaces',
      description: 'List available workspaces.',
      parameters: { type: 'object', properties: {} },
    },
    run: async (client) => {
      const workspaces = await client.listWorkspaces();
      return JSON.stringify(workspaces.map((w) => w.name));
    },
  },
  {
    spec: {
      name: 'create_note',
      description: 'Create a new note.',
      parameters: {
        type: 'object',
        properties: {
          heading: { type: 'string', description: 'Note title' },
          content: { type: 'string', description: 'Note content (HTML or plain text)' },
          tags: { type: 'string', description: 'Comma-separated tags' },
          folder: { type: 'string', description: 'Folder name to place the note in' },
          workspace: { type: 'string', description: 'Workspace name' },
        },
        required: ['heading'],
      },
    },
    run: async (client, args) => {
      const heading = typeof args.heading === 'string' ? args.heading.trim() : '';
      if (!heading) return err('heading is required');

      let folderId: number | null | undefined;
      if (args.folder !== undefined && args.folder !== '') {
        const resolved = await resolveFolderId(client, args.folder);
        if (typeof resolved === 'string') return resolved;
        folderId = resolved;
      }
      const id = await client.createNote({
        heading,
        content: typeof args.content === 'string' ? args.content : undefined,
        tags: typeof args.tags === 'string' ? args.tags : undefined,
        folder_id: folderId,
        workspace: typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined,
      });
      return JSON.stringify({ id, heading });
    },
  },
  {
    spec: {
      name: 'update_note',
      description: 'Update title, content or tags of an existing note. Only provided fields are changed.',
      parameters: {
        type: 'object',
        properties: {
          ...NOTE_REF,
          new_heading: { type: 'string', description: 'New title' },
          content: { type: 'string', description: 'New full content' },
          tags: { type: 'string', description: 'New comma-separated tags' },
        },
      },
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const payload: Record<string, string> = {};
      if (typeof args.new_heading === 'string' && args.new_heading.trim()) payload.heading = args.new_heading.trim();
      if (typeof args.content === 'string') payload.content = args.content;
      if (typeof args.tags === 'string') payload.tags = args.tags;
      if (Object.keys(payload).length === 0) return err('nothing to update: provide new_heading, content or tags');
      await client.updateNote(resolved.id, payload);
      return JSON.stringify({ ok: true, id: resolved.id });
    },
  },
  {
    spec: {
      name: 'append_to_note',
      description: 'Append text to the end of an existing note.',
      parameters: {
        type: 'object',
        properties: {
          ...NOTE_REF,
          text: { type: 'string', description: 'Text to append' },
        },
        required: ['text'],
      },
    },
    run: async (client, args) => {
      const text = typeof args.text === 'string' ? args.text : '';
      if (!text.trim()) return err('text is required');
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const note = await client.getNote(resolved.id);
      await client.updateNote(resolved.id, { content: `${note.content}\n${text}` });
      return JSON.stringify({ ok: true, id: resolved.id });
    },
  },
  {
    spec: {
      name: 'move_note_to_folder',
      description: 'Move a note to a folder (by folder name or id).',
      parameters: {
        type: 'object',
        properties: {
          ...NOTE_REF,
          folder: { type: 'string', description: 'Target folder name' },
        },
        required: ['folder'],
      },
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      await client.moveNoteToFolder(resolved.id, folderId);
      return JSON.stringify({ ok: true, id: resolved.id, folder_id: folderId });
    },
  },
  {
    spec: {
      name: 'delete_note',
      description: 'Move a note to trash (recoverable). Requires user approval.',
      parameters: { type: 'object', properties: { ...NOTE_REF } },
    },
    requiresApproval: true,
    approvalPreview: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return translate('chat.approvalGeneric', { tool: 'delete_note' });
      const note = await client.getNote(resolved.id);
      return translate('chat.approvalDeleteNote', { heading: note.heading });
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      await client.deleteNote(resolved.id);
      return JSON.stringify({ ok: true, id: resolved.id });
    },
  },

  // ===== Trash =====
  {
    spec: {
      name: 'list_trash',
      description: 'List notes in trash.',
      parameters: {
        type: 'object',
        properties: { workspace: { type: 'string', description: 'Filter by workspace name' } },
      },
    },
    run: async (client, args) => {
      const workspace = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined;
      const notes = await client.listTrash(workspace);
      return JSON.stringify(
        notes.slice(0, 25).map((n) => ({ id: n.id, heading: n.heading, folder: n.folder, updated: n.updated })),
      );
    },
  },
  {
    spec: {
      name: 'restore_note',
      description: 'Restore a note from trash.',
      parameters: { type: 'object', properties: { ...NOTE_REF } },
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      await client.restoreNote(resolved.id);
      return JSON.stringify({ ok: true, id: resolved.id });
    },
  },
  {
    spec: {
      name: 'empty_trash',
      description: 'Permanently delete all notes in trash. IRREVERSIBLE. Requires user approval.',
      parameters: { type: 'object', properties: {} },
    },
    requiresApproval: true,
    approvalPreview: async (client) => {
      const notes = await client.listTrash();
      return translate('chat.approvalEmptyTrash', { count: notes.length });
    },
    run: async (client) => {
      await client.emptyTrash();
      return JSON.stringify({ ok: true });
    },
  },

  // ===== Folders =====
  {
    spec: {
      name: 'create_folder',
      description: 'Create a new folder.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Folder name' },
          workspace: { type: 'string', description: 'Workspace name' },
        },
        required: ['name'],
      },
    },
    run: async (client, args) => {
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (!name) return err('name is required');
      const id = await client.createFolder({
        name,
        workspace: typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : undefined,
      });
      return JSON.stringify({ id, name });
    },
  },
  {
    spec: {
      name: 'rename_folder',
      description: 'Rename a folder.',
      parameters: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Current folder name' },
          new_name: { type: 'string', description: 'New folder name' },
        },
        required: ['folder', 'new_name'],
      },
    },
    run: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      const newName = typeof args.new_name === 'string' ? args.new_name.trim() : '';
      if (!newName) return err('new_name is required');
      await client.renameFolder(folderId, newName);
      return JSON.stringify({ ok: true, id: folderId, name: newName });
    },
  },
  {
    spec: {
      name: 'empty_folder',
      description: 'Move all notes of a folder to trash (folder itself stays). Requires user approval.',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string', description: 'Folder name' } },
        required: ['folder'],
      },
    },
    requiresApproval: true,
    approvalPreview: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return translate('chat.approvalGeneric', { tool: 'empty_folder' });
      const count = await client.getFolderNoteCount(folderId);
      return translate('chat.approvalEmptyFolder', { name: String(args.folder), count });
    },
    run: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      await client.emptyFolder(folderId);
      return JSON.stringify({ ok: true, id: folderId });
    },
  },
  {
    spec: {
      name: 'delete_folder',
      description: 'Delete a folder (notes inside are kept, they become uncategorized). Requires user approval.',
      parameters: {
        type: 'object',
        properties: { folder: { type: 'string', description: 'Folder name' } },
        required: ['folder'],
      },
    },
    requiresApproval: true,
    approvalPreview: async (_client, args) =>
      translate('chat.approvalDeleteFolder', { name: String(args.folder ?? '') }),
    run: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      await client.deleteFolder(folderId);
      return JSON.stringify({ ok: true, id: folderId });
    },
  },

  // ===== Batch operations =====
  {
    spec: {
      name: 'move_notes_by_query',
      description: 'Find notes by text (optionally by date range) and move ALL of them into a folder. Returns a report of moved notes.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text (empty = all notes in range)' },
          folder: { type: 'string', description: 'Target folder name' },
          created_after: { type: 'string', description: 'Only notes created after this date (YYYY-MM-DD)' },
          created_before: { type: 'string', description: 'Only notes created before this date (YYYY-MM-DD)' },
          limit: { type: 'number', description: 'Max notes to move (default 50)' },
        },
        required: ['folder'],
      },
    },
    run: async (client, args) => {
      const folderId = await resolveFolderId(client, args.folder);
      if (typeof folderId === 'string') return folderId;
      const notes = await findByQuery(client, args);
      if (notes.length === 0) return err('no notes match the query');
      for (const n of notes) {
        await client.moveNoteToFolder(n.id, folderId); // eslint-disable-line no-await-in-loop
      }
      return JSON.stringify({ moved: notes.length, notes: notes.map((n) => `#${n.id} "${n.heading}"`) });
    },
  },
  {
    spec: {
      name: 'tag_notes_by_query',
      description: 'Add (or replace) tags on ALL notes matching a text query. Returns a report.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          tags: { type: 'string', description: 'Comma-separated tags' },
          mode: { type: 'string', enum: ['add', 'replace'], description: 'add = merge with existing tags (default), replace = overwrite' },
          created_after: { type: 'string', description: 'Only notes created after this date (YYYY-MM-DD)' },
          created_before: { type: 'string', description: 'Only notes created before this date (YYYY-MM-DD)' },
          limit: { type: 'number', description: 'Max notes to tag (default 50)' },
        },
        required: ['tags'],
      },
    },
    run: async (client, args) => {
      const tags = typeof args.tags === 'string' ? args.tags.trim() : '';
      if (!tags) return err('tags is required');
      const notes = await findByQuery(client, args);
      if (notes.length === 0) return err('no notes match the query');
      const mode = args.mode === 'replace' ? 'replace' : 'add';
      for (const n of notes) {
        let next = tags;
        if (mode === 'add') {
          const existing = (n.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          const merged = [...existing];
          tags.split(',').map((s) => s.trim()).filter(Boolean).forEach((tg) => {
            if (!merged.includes(tg)) merged.push(tg);
          });
          next = merged.join(',');
        }
        await client.updateTags(n.id, next); // eslint-disable-line no-await-in-loop
      }
      return JSON.stringify({ tagged: notes.length, mode, notes: notes.map((n) => `#${n.id} "${n.heading}"`) });
    },
  },
  {
    spec: {
      name: 'delete_notes_by_query',
      description: 'Move ALL notes matching a text query to trash. Requires user approval.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text' },
          created_after: { type: 'string', description: 'Only notes created after this date (YYYY-MM-DD)' },
          created_before: { type: 'string', description: 'Only notes created before this date (YYYY-MM-DD)' },
          limit: { type: 'number', description: 'Max notes to delete (default 50)' },
        },
      },
    },
    requiresApproval: true,
    approvalPreview: async (client, args) => {
      const notes = await findByQuery(client, args);
      return translate('chat.approvalDeleteByQuery', {
        query: String(args.query ?? ''),
        count: notes.length,
      });
    },
    run: async (client, args) => {
      const notes = await findByQuery(client, args);
      if (notes.length === 0) return err('no notes match the query');
      for (const n of notes) {
        await client.deleteNote(n.id); // eslint-disable-line no-await-in-loop
      }
      return JSON.stringify({ deleted: notes.length, notes: notes.map((n) => `#${n.id} "${n.heading}"`) });
    },
  },

  // ===== Tags & favorites =====
  {
    spec: {
      name: 'add_tags',
      description: 'Add tags to a note, keeping existing ones.',
      parameters: {
        type: 'object',
        properties: {
          ...NOTE_REF,
          tags: { type: 'string', description: 'Comma-separated tags to add' },
        },
        required: ['tags'],
      },
    },
    run: async (client, args) => {
      const tags = typeof args.tags === 'string' ? args.tags.trim() : '';
      if (!tags) return err('tags is required');
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const note = await client.getNote(resolved.id);
      const existing = (note.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      tags.split(',').map((s) => s.trim()).filter(Boolean).forEach((tg) => {
        if (!existing.includes(tg)) existing.push(tg);
      });
      await client.updateTags(resolved.id, existing.join(','));
      return JSON.stringify({ ok: true, id: resolved.id, tags: existing });
    },
  },
  {
    spec: {
      name: 'toggle_favorite',
      description: 'Toggle favorite mark of a note.',
      parameters: { type: 'object', properties: { ...NOTE_REF } },
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      await client.toggleFavorite(resolved.id);
      return JSON.stringify({ ok: true, id: resolved.id });
    },
  },
  {
    spec: {
      name: 'duplicate_note',
      description: 'Create a copy of a note.',
      parameters: { type: 'object', properties: { ...NOTE_REF } },
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const newId = await client.duplicateNote(resolved.id);
      return JSON.stringify({ ok: true, id: resolved.id, copy_id: newId });
    },
  },

  // ===== Smart operations =====
  {
    spec: {
      name: 'merge_notes',
      description:
        'Merge several notes into one: contents are concatenated (oldest first), source notes are moved to trash. ' +
        'By default merges into the first note; pass target_heading to create a new note instead.',
      parameters: {
        type: 'object',
        properties: {
          notes: {
            type: 'array',
            items: { type: ['string', 'number'] },
            description: 'Note titles or ids to merge (2 or more)',
          },
          target_heading: { type: 'string', description: 'If set — create a NEW note with this title instead of merging into the first one' },
        },
        required: ['notes'],
      },
    },
    run: async (client, args) => {
      if (!Array.isArray(args.notes) || args.notes.length < 2) return err('notes: need at least 2 notes');
      const ids: number[] = [];
      for (const ref of args.notes) {
        const resolved = await resolveNoteId(client, typeof ref === 'number' ? { note_id: ref } : { heading: ref }); // eslint-disable-line no-await-in-loop
        if (typeof resolved === 'string') return resolved;
        ids.push(resolved);
      }
      const details = [];
      for (const id of ids) {
        details.push(await client.getNote(id)); // eslint-disable-line no-await-in-loop
      }
      const merged = details.map((d) => d.content).join('\n\n---\n\n');
      const targetHeading = typeof args.target_heading === 'string' ? args.target_heading.trim() : '';
      let targetId: number;
      let trashed: number[];
      if (targetHeading) {
        targetId = await client.createNote({ heading: targetHeading, content: merged });
        trashed = ids;
      } else {
        targetId = ids[0];
        await client.updateNote(targetId, { content: merged });
        trashed = ids.slice(1);
      }
      for (const id of trashed) {
        await client.deleteNote(id); // eslint-disable-line no-await-in-loop
      }
      return JSON.stringify({ ok: true, target_id: targetId, merged: ids.length, trashed });
    },
  },
  {
    spec: {
      name: 'search_and_replace',
      description: 'Replace text inside a note without rewriting the whole content.',
      parameters: {
        type: 'object',
        properties: {
          ...NOTE_REF,
          find: { type: 'string', description: 'Exact text to find' },
          replace: { type: 'string', description: 'Replacement text' },
        },
        required: ['find', 'replace'],
      },
    },
    run: async (client, args) => {
      const find = typeof args.find === 'string' ? args.find : '';
      const replace = typeof args.replace === 'string' ? args.replace : '';
      if (!find) return err('find is required');
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const note = await client.getNote(resolved.id);
      const count = note.content.split(find).length - 1;
      if (count === 0) return err(`text not found in note: "${find}"`);
      await client.updateNote(resolved.id, { content: note.content.split(find).join(replace) });
      return JSON.stringify({ ok: true, id: resolved.id, replaced: count });
    },
  },
  {
    spec: {
      name: 'convert_note_format',
      description: 'Convert a note between HTML and Markdown formats.',
      parameters: {
        type: 'object',
        properties: {
          ...NOTE_REF,
          format: { type: 'string', enum: ['markdown', 'html'], description: 'Target format' },
        },
        required: ['format'],
      },
    },
    run: async (client, args) => {
      const format = args.format === 'markdown' ? 'markdown' : args.format === 'html' ? 'html' : null;
      if (!format) return err('format must be "markdown" or "html"');
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      await client.convertNote(resolved.id, format);
      return JSON.stringify({ ok: true, id: resolved.id, format });
    },
  },
  {
    spec: {
      name: 'move_note_to_workspace',
      description: 'Move a note to another workspace.',
      parameters: {
        type: 'object',
        properties: {
          ...NOTE_REF,
          workspace: { type: 'string', description: 'Target workspace name' },
        },
        required: ['workspace'],
      },
    },
    run: async (client, args) => {
      const workspace = typeof args.workspace === 'string' ? args.workspace.trim() : '';
      if (!workspace) return err('workspace is required');
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      await client.updateNote(resolved.id, { workspace });
      return JSON.stringify({ ok: true, id: resolved.id, workspace });
    },
  },
  {
    spec: {
      name: 'list_uncategorized_notes',
      description: 'List notes that are not in any folder.',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max results (default 25)' } },
      },
    },
    run: async (client, args) => {
      const notes = await client.listNotes({ sort: 'updated_desc' });
      const uncategorized = notes.filter((n) => n.folder_id === null);
      return JSON.stringify(uncategorized.slice(0, clampLimit(args.limit, 25)).map(compactNote));
    },
  },
  {
    spec: {
      name: 'get_note_stats',
      description: 'Overview statistics: total notes, favorites, counts by folder and workspace, trash count.',
      parameters: { type: 'object', properties: {} },
    },
    run: async (client) => {
      const [notes, trash] = await Promise.all([client.listNotes({}), client.listTrash()]);
      const byFolder: Record<string, number> = {};
      const byWorkspace: Record<string, number> = {};
      notes.forEach((n) => {
        const f = n.folder ?? 'uncategorized';
        byFolder[f] = (byFolder[f] ?? 0) + 1;
        const w = n.workspace ?? 'default';
        byWorkspace[w] = (byWorkspace[w] ?? 0) + 1;
      });
      return JSON.stringify({
        total: notes.length,
        favorites: notes.filter((n) => n.favorite === 1).length,
        by_folder: byFolder,
        by_workspace: byWorkspace,
        trash: trash.length,
      });
    },
  },
  {
    spec: {
      name: 'get_backlinks',
      description: 'List notes that link to the given note.',
      parameters: { type: 'object', properties: { ...NOTE_REF } },
    },
    run: async (client, args) => {
      const resolved = await resolveNoteOrError(client, args);
      if ('error' in resolved) return resolved.error;
      const backlinks = await client.getBacklinks(resolved.id);
      return JSON.stringify(backlinks.map((b) => ({ id: b.id, heading: b.heading, workspace: b.workspace })));
    },
  },
];
