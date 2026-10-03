import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { PoznoteClient } from '../../api/client';
import { NoteListItem } from '../../api/types';
import { POZNOTE_TOOLS } from '../tools';

// Mock i18n: approvalPreview uses translate()
jest.mock('../../i18n', () => ({
  translate: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}));

function noteItem(partial: Partial<NoteListItem>): NoteListItem {
  return {
    id: 1,
    heading: 'Note',
    type: 'note',
    tags: null,
    folder: null,
    folder_id: null,
    workspace: 'Personal',
    updated: '2026-07-27 12:00:00',
    created: '2026-07-26 12:00:00',
    favorite: 0,
    icon: null,
    icon_color: null,
    color: null,
    color_hex: null,
    ...partial,
  };
}

function makeClient(overrides: Record<string, unknown> = {}): PoznoteClient {
  const fn = () => jest.fn<(...args: any[]) => Promise<any>>();
  const base: Record<string, unknown> = {
    listNotes: fn().mockResolvedValue([]),
    searchNotes: fn().mockResolvedValue([]),
    getNote: fn().mockResolvedValue({ id: 1, heading: 'Note', content: '<p>text</p>', tags: 'a,b' }),
    createNote: fn().mockResolvedValue(42),
    updateNote: fn().mockResolvedValue(undefined),
    deleteNote: fn().mockResolvedValue(undefined),
    restoreNote: fn().mockResolvedValue(undefined),
    listTrash: fn().mockResolvedValue([]),
    emptyTrash: fn().mockResolvedValue(undefined),
    listFolders: fn().mockResolvedValue([
      { id: 5, name: 'Projects', parent_id: null, display_order: 0 },
    ]),
    getFolderCounts: fn().mockResolvedValue({ '5': 3 }),
    getFolderNoteCount: fn().mockResolvedValue(3),
    createFolder: fn().mockResolvedValue(7),
    renameFolder: fn().mockResolvedValue(undefined),
    deleteFolder: fn().mockResolvedValue(undefined),
    emptyFolder: fn().mockResolvedValue(undefined),
    moveNoteToFolder: fn().mockResolvedValue(undefined),
    updateTags: fn().mockResolvedValue(undefined),
    toggleFavorite: fn().mockResolvedValue(undefined),
    duplicateNote: fn().mockResolvedValue(43),
    convertNote: fn().mockResolvedValue(undefined),
    listWorkspaces: fn().mockResolvedValue([{ name: 'Personal' }, { name: 'Work' }]),
    getBacklinks: fn().mockResolvedValue([{ id: 2, heading: 'Other', workspace: 'Personal' }]),
  };
  return { ...base, ...overrides } as unknown as PoznoteClient;
}

function tool(name: string) {
  const found = POZNOTE_TOOLS.find((t) => t.spec.name === name);
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

describe('POZNOTE_TOOLS', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('каталог: 30 инструментов, approval только у деструктивных', () => {
    expect(POZNOTE_TOOLS).toHaveLength(30);
    const approval = POZNOTE_TOOLS.filter((t) => t.requiresApproval).map((t) => t.spec.name);
    expect(approval.sort()).toEqual([
      'delete_folder',
      'delete_note',
      'delete_notes_by_query',
      'empty_folder',
      'empty_trash',
    ]);
  });

  it('search_notes: компактный вывод с лимитом', async () => {
    const client = makeClient({
      listNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([
        noteItem({ id: 1, heading: 'A' }),
        noteItem({ id: 2, heading: 'B' }),
      ]),
    });
    const out = JSON.parse(await tool('search_notes').run(client, { query: 'a' }));
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 1,
      heading: 'A',
      tags: null,
      folder: null,
      workspace: 'Personal',
      updated: '2026-07-27 12:00:00',
    });
    expect(client.listNotes).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'a', sort: 'updated_desc' }),
    );
  });

  it('get_note по заголовку: точное совпадение среди частичных', async () => {
    const client = makeClient({
      searchNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([
        noteItem({ id: 1, heading: 'Docker (draft)' }),
        noteItem({ id: 2, heading: 'Docker' }),
      ]),
    });
    await tool('get_note').run(client, { heading: 'docker' });
    // of the two candidates the exact match (id 2) is chosen, not the first in the list
    expect(client.getNote).toHaveBeenCalledWith(2);
  });

  it('get_note: неоднозначный заголовок → ошибка с кандидатами', async () => {
    const client = makeClient({
      searchNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([
        noteItem({ id: 1, heading: 'Docker one' }),
        noteItem({ id: 2, heading: 'Docker two' }),
      ]),
    });
    const out = JSON.parse(await tool('get_note').run(client, { heading: 'docker' }));
    expect(out.error).toContain('ambiguous');
    expect(out.error).toContain('#1');
    expect(out.error).toContain('#2');
  });

  it('create_note: имя папки резолвится в id', async () => {
    const client = makeClient();
    const out = JSON.parse(await tool('create_note').run(client, { heading: 'New', folder: 'projects' }));
    expect(out).toEqual({ id: 42, heading: 'New' });
    expect(client.createNote).toHaveBeenCalledWith(expect.objectContaining({ folder_id: 5 }));
  });

  it('create_note: неизвестная папка → ошибка со списком доступных', async () => {
    const client = makeClient();
    const out = JSON.parse(await tool('create_note').run(client, { heading: 'New', folder: 'Nope' }));
    expect(out.error).toContain('folder not found');
    expect(out.error).toContain('Projects');
    expect(client.createNote).not.toHaveBeenCalled();
  });

  it('search_and_replace: считает замены, ошибка если текст не найден', async () => {
    const client = makeClient({
      getNote: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        id: 1,
        heading: 'N',
        content: 'v1.4 и ещё раз v1.4',
      }),
    });
    const ok = JSON.parse(await tool('search_and_replace').run(client, { note_id: 1, find: 'v1.4', replace: 'v1.5' }));
    expect(ok).toEqual({ ok: true, id: 1, replaced: 2 });
    expect(client.updateNote).toHaveBeenCalledWith(1, { content: 'v1.5 и ещё раз v1.5' });

    const miss = JSON.parse(await tool('search_and_replace').run(client, { note_id: 1, find: 'zzz', replace: 'q' }));
    expect(miss.error).toContain('text not found');
  });

  it('move_notes_by_query: перемещает все найденные с отчётом', async () => {
    const client = makeClient({
      listNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([
        noteItem({ id: 1, heading: 'A' }),
        noteItem({ id: 2, heading: 'B' }),
      ]),
    });
    const out = JSON.parse(await tool('move_notes_by_query').run(client, { query: 'x', folder: 'Projects' }));
    expect(out.moved).toBe(2);
    expect(client.moveNoteToFolder).toHaveBeenCalledWith(1, 5);
    expect(client.moveNoteToFolder).toHaveBeenCalledWith(2, 5);
  });

  it('tag_notes_by_query: режим add мержит теги без дублей', async () => {
    const client = makeClient({
      listNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([
        noteItem({ id: 1, heading: 'A', tags: 'one,two' }),
      ]),
    });
    const out = JSON.parse(await tool('tag_notes_by_query').run(client, { query: 'x', tags: 'two,three' }));
    expect(out.tagged).toBe(1);
    expect(client.updateTags).toHaveBeenCalledWith(1, 'one,two,three');
  });

  it('merge_notes: склейка в первую заметку, остальные в корзину', async () => {
    const client = makeClient({
      searchNotes: jest.fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValueOnce([noteItem({ id: 1, heading: 'A' })])
        .mockResolvedValueOnce([noteItem({ id: 2, heading: 'B' })]),
      getNote: jest.fn<(...args: any[]) => Promise<any>>()
        .mockResolvedValueOnce({ id: 1, heading: 'A', content: 'aaa' })
        .mockResolvedValueOnce({ id: 2, heading: 'B', content: 'bbb' }),
    });
    const out = JSON.parse(await tool('merge_notes').run(client, { notes: ['A', 'B'] }));
    expect(out).toEqual({ ok: true, target_id: 1, merged: 2, trashed: [2] });
    expect(client.updateNote).toHaveBeenCalledWith(1, { content: 'aaa\n\n---\n\nbbb' });
    expect(client.deleteNote).toHaveBeenCalledWith(2);
  });

  it('merge_notes: меньше двух заметок → ошибка', async () => {
    const client = makeClient();
    const out = JSON.parse(await tool('merge_notes').run(client, { notes: ['A'] }));
    expect(out.error).toContain('at least 2');
  });

  it('get_note_stats: сводка по папкам и корзине', async () => {
    const client = makeClient({
      listNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([
        noteItem({ id: 1, folder: 'P', favorite: 1 }),
        noteItem({ id: 2, folder: 'P' }),
        noteItem({ id: 3 }),
      ]),
      listTrash: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([{ id: 9 }]),
    });
    const out = JSON.parse(await tool('get_note_stats').run(client, {}));
    expect(out).toEqual({
      total: 3,
      favorites: 1,
      by_folder: { P: 2, uncategorized: 1 },
      by_workspace: { Personal: 3 },
      trash: 1,
    });
  });

  it('empty_trash: approvalPreview содержит количество', async () => {
    const client = makeClient({
      listTrash: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([{ id: 1 }, { id: 2 }]),
    });
    const preview = await tool('empty_trash').approvalPreview!(client, {});
    expect(preview).toContain('"count":2');
  });
});
