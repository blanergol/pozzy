import { jest, describe, it, expect } from '@jest/globals';
import { PoznoteClient } from '../../api/client';
import { NoteListItem } from '../../api/types';
import {
  clampLimit,
  compactNote,
  err,
  findByQuery,
  resolveFolderId,
  resolveNoteId,
} from '../toolHelpers';

function noteItem(partial: Partial<NoteListItem>): NoteListItem {
  return {
    id: 1,
    heading: 'Note',
    type: 'note',
    tags: null,
    folder: null,
    folder_id: null,
    workspace: 'Personal',
    updated: 'u',
    created: 'c',
    favorite: 0,
    icon: null,
    icon_color: null,
    color: null,
    color_hex: null,
    ...partial,
  };
}

function makeClient(overrides: Record<string, unknown> = {}): PoznoteClient {
  return {
    searchNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
    listNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
    listFolders: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([
      { id: 5, name: 'Projects', parent_id: null, display_order: 0 },
    ]),
    ...overrides,
  } as unknown as PoznoteClient;
}

describe('toolHelpers', () => {
  it('err возвращает JSON с error', () => {
    expect(JSON.parse(err('boom'))).toEqual({ error: 'boom' });
  });

  it('compactNote отбрасывает лишние поля', () => {
    const compact = compactNote(noteItem({ id: 7, heading: 'A', type: 'markdown' }));
    expect(compact).toEqual({
      id: 7,
      heading: 'A',
      tags: null,
      folder: null,
      workspace: 'Personal',
      updated: 'u',
    });
    expect('type' in compact).toBe(false);
  });

  it('clampLimit: дефолт, кап 25, невалидные значения', () => {
    expect(clampLimit(undefined)).toBe(10);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(999)).toBe(25);
    expect(clampLimit(-3)).toBe(10);
    expect(clampLimit('abc')).toBe(10);
    expect(clampLimit(12, 25)).toBe(12);
  });

  it('resolveNoteId: прямой note_id без поиска', async () => {
    const client = makeClient();
    expect(await resolveNoteId(client, { note_id: 7 })).toBe(7);
    expect(client.searchNotes).not.toHaveBeenCalled();
  });

  it('resolveNoteId: без параметров → ошибка', async () => {
    const out = await resolveNoteId(makeClient(), {});
    expect(JSON.parse(String(out)).error).toContain('required');
  });

  it('resolveNoteId: не найдено → ошибка', async () => {
    const out = await resolveNoteId(makeClient(), { heading: 'zzz' });
    expect(JSON.parse(String(out)).error).toContain('not found');
  });

  it('resolveFolderId: числовой id напрямую', async () => {
    const client = makeClient();
    expect(await resolveFolderId(client, 5)).toBe(5);
    expect(client.listFolders).not.toHaveBeenCalled();
  });

  it('resolveFolderId: по имени без учёта регистра', async () => {
    expect(await resolveFolderId(makeClient(), 'projects')).toBe(5);
  });

  it('resolveFolderId: не найдена → ошибка с доступными', async () => {
    const out = await resolveFolderId(makeClient(), 'Nope');
    expect(JSON.parse(String(out)).error).toContain('Projects');
  });

  it('findByQuery: маппинг дат и лимит по умолчанию', async () => {
    const client = makeClient();
    await findByQuery(client, { query: 'x', created_after: '2026-01-01', created_before: '2026-02-01' });
    expect(client.listNotes).toHaveBeenCalledWith({
      search: 'x',
      created_from: '2026-01-01',
      created_to: '2026-02-01',
      sort: 'updated_desc',
    });
  });

  it('findByQuery: лимит 50 по умолчанию и кап 100', async () => {
    const many = Array.from({ length: 120 }, (_, i) => noteItem({ id: i + 1 }));
    const client = makeClient({
      listNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(many),
    });
    expect(await findByQuery(client, {})).toHaveLength(50);
    expect(await findByQuery(client, { limit: 200 })).toHaveLength(100);
  });
});
