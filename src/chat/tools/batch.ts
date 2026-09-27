import { translate } from '../../i18n';
import { err, findByQuery, resolveFolderId } from '../toolHelpers';
import { PoznoteTool } from './types';

/** Пакетные операции над заметками по текстовому запросу (с фильтрами по датам). */
export const BATCH_TOOLS: PoznoteTool[] = [
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
];
