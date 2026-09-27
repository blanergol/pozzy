import { translate } from '../../i18n';
import {
  clampLimit,
  compactNote,
  err,
  NOTE_REF,
  resolveFolderId,
  resolveNoteOrError,
} from '../toolHelpers';
import { PoznoteTool } from './types';

/** Базовые инструменты заметок: поиск, чтение, создание, правки, перемещение, удаление. */
export const NOTE_TOOLS: PoznoteTool[] = [
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
];
