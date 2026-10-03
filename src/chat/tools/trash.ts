import { translate } from '../../i18n';
import { NOTE_REF, resolveNoteOrError } from '../toolHelpers';
import { PoznoteTool } from './types';

/** Trash tools: list, restore, empty. */
export const TRASH_TOOLS: PoznoteTool[] = [
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
];
