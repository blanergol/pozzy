import {
  clampLimit,
  compactNote,
  err,
  NOTE_REF,
  resolveNoteId,
  resolveNoteOrError,
} from '../toolHelpers';
import { PoznoteTool } from './types';

/** Composite and analytical operations: merge, text replacement, conversion, statistics. */
export const SMART_TOOLS: PoznoteTool[] = [
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
