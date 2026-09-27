import { err, NOTE_REF, resolveNoteOrError } from '../toolHelpers';
import { PoznoteTool } from './types';

/** Теги, избранное, копирование. */
export const MISC_TOOLS: PoznoteTool[] = [
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
];
