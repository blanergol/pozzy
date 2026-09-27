import AsyncStorage from '@react-native-async-storage/async-storage';
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import {
  RepoContext,
  isTempNoteId,
  repoCreateNote,
  repoDeleteNote,
  repoGetNote,
  repoListNotes,
  repoUpdateNote,
} from '../notesRepository';
import { syncNow } from '../sync';
import { loadOfflineData, updateOfflineData } from '../../storage/offlineStore';
import { NoteListItem } from '../../api/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const fn = () => jest.fn<(...args: any[]) => Promise<any>>();

function makeClient(overrides: Record<string, any> = {}): any {
  return {
    listNotes: fn().mockResolvedValue([]),
    listFolders: fn().mockResolvedValue([]),
    getNote: fn(),
    createNote: fn().mockResolvedValue(100),
    updateNote: fn().mockResolvedValue(undefined),
    deleteNote: fn().mockResolvedValue(undefined),
    toggleFavorite: fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeCtx(client: any, profileId: string, isOnline: boolean): RepoContext {
  return {
    client,
    profileId,
    isOnline,
    reportNetworkError: jest.fn(),
    reportSuccess: jest.fn(),
  };
}

function serverNote(id: number, updated: string): NoteListItem {
  return {
    id,
    heading: `Note ${id}`,
    type: 'note',
    tags: null,
    folder: null,
    folder_id: null,
    workspace: null,
    updated,
    created: updated,
    favorite: 0,
    icon: null,
    icon_color: null,
    color: null,
    color_hex: null,
  };
}

let profileSeq = 0;
function freshProfileId(): string {
  // in-memory кэш offlineStore живёт между тестами — изолируемся уникальным id
  return `test-profile-${++profileSeq}`;
}

beforeEach(async () => {
  await (AsyncStorage as any).clear();
});

describe('notesRepository (offline)', () => {
  it('оффлайн-обновление пишется в кэш и очередь', async () => {
    const profileId = freshProfileId();
    await updateOfflineData(profileId, (d) => {
      d.notesList = [serverNote(1, '2026-01-01 10:00:00')];
      d.notesDetails['1'] = {
        ...serverNote(1, '2026-01-01 10:00:00'),
        linked_note_id: null,
        reminder_at: null,
        content: 'старое',
      };
    });

    const ctx = makeCtx(makeClient(), profileId, false);
    await repoUpdateNote(ctx, 1, { heading: 'Новый заголовок', content: 'новое' });

    const data = await loadOfflineData(profileId);
    expect(data.notesDetails['1'].heading).toBe('Новый заголовок');
    expect(data.notesDetails['1'].content).toBe('новое');
    expect(data.notesDetails['1'].localUpdatedAt).toBeTruthy();
    expect(data.notesList[0].heading).toBe('Новый заголовок');
    expect(data.pending).toHaveLength(1);
    expect(data.pending[0].type).toBe('update');
    expect(data.pending[0].noteId).toBe(1);
  });

  it('повторное оффлайн-обновление сливается в одну операцию', async () => {
    const profileId = freshProfileId();
    await updateOfflineData(profileId, (d) => {
      d.notesList = [serverNote(1, '2026-01-01 10:00:00')];
    });

    const ctx = makeCtx(makeClient(), profileId, false);
    await repoUpdateNote(ctx, 1, { heading: 'A' });
    await repoUpdateNote(ctx, 1, { heading: 'B' });

    const data = await loadOfflineData(profileId);
    expect(data.pending).toHaveLength(1);
    expect(data.pending[0].payload.heading).toBe('B');
  });

  it('оффлайн-создание даёт временный отрицательный id и pending create', async () => {
    const profileId = freshProfileId();
    const ctx = makeCtx(makeClient(), profileId, false);
    const id = await repoCreateNote(ctx, { heading: 'Локальная', content: '' });

    expect(isTempNoteId(id)).toBe(true);

    const data = await loadOfflineData(profileId);
    expect(data.notesList[0].id).toBe(id);
    expect(data.notesList[0].heading).toBe('Локальная');
    expect(data.pending).toHaveLength(1);
    expect(data.pending[0].type).toBe('create');

    // заметка доступна из кэша для редактора
    const note = await repoGetNote(makeCtx(makeClient(), profileId, false), id);
    expect(note.heading).toBe('Локальная');
  });

  it('удаление оффлайн-созданной заметки не добавляет delete в очередь', async () => {
    const profileId = freshProfileId();
    const ctx = makeCtx(makeClient(), profileId, false);
    const id = await repoCreateNote(ctx, { heading: 'X', content: '' });
    await repoDeleteNote(ctx, id);

    const data = await loadOfflineData(profileId);
    expect(data.pending).toHaveLength(0);
    expect(data.notesList).toHaveLength(0);
  });

  it('оффлайн-список читается из кэша с фильтром поиска', async () => {
    const profileId = freshProfileId();
    await updateOfflineData(profileId, (d) => {
      d.notesList = [
        { ...serverNote(1, '2026-01-02 10:00:00'), heading: 'Молоко' },
        { ...serverNote(2, '2026-01-01 10:00:00'), heading: 'Хлеб' },
      ];
    });

    const ctx = makeCtx(makeClient(), profileId, false);
    const all = await repoListNotes(ctx, {});
    expect(all.fromCache).toBe(true);
    expect(all.notes).toHaveLength(2);
    // сортировка updated_desc
    expect(all.notes[0].id).toBe(1);

    const found = await repoListNotes(ctx, { search: 'мол' });
    expect(found.notes).toHaveLength(1);
    expect(found.notes[0].heading).toBe('Молоко');
  });
});

describe('syncNow (last-write-wins)', () => {
  it('пушит локальную правку, если она новее серверной', async () => {
    const profileId = freshProfileId();
    const client = makeClient({
      listNotes: fn().mockResolvedValue([serverNote(1, '2026-01-01 10:00:00')]),
    });
    await updateOfflineData(profileId, (d) => {
      d.notesList = [serverNote(1, '2026-01-01 10:00:00')];
      d.pending = [
        {
          opId: 'op1',
          type: 'update',
          noteId: 1,
          payload: { heading: 'Локальная правка' },
          clientTs: '2026-01-05T10:00:00.000Z',
        },
      ];
    });

    const pushed = await syncNow(client, profileId);
    expect(pushed).toBe(1);
    expect(client.updateNote).toHaveBeenCalledWith(1, expect.objectContaining({ heading: 'Локальная правка' }));

    const data = await loadOfflineData(profileId);
    expect(data.pending).toHaveLength(0);
  });

  it('отбрасывает локальную правку, если серверная новее (LWW)', async () => {
    const profileId = freshProfileId();
    const client = makeClient({
      listNotes: fn().mockResolvedValue([serverNote(1, '2026-06-01 10:00:00')]),
    });
    await updateOfflineData(profileId, (d) => {
      d.notesList = [serverNote(1, '2026-01-01 10:00:00')];
      d.pending = [
        {
          opId: 'op1',
          type: 'update',
          noteId: 1,
          payload: { heading: 'Старая локальная правка' },
          clientTs: '2026-01-05T10:00:00.000Z',
        },
      ];
    });

    await syncNow(client, profileId);
    expect(client.updateNote).not.toHaveBeenCalled();

    const data = await loadOfflineData(profileId);
    expect(data.pending).toHaveLength(0);
    // кэш обновлён серверным снимком
    expect(data.notesList[0].updated).toBe('2026-06-01 10:00:00');
  });

  it('создаёт оффлайн-заметку на сервере и перепривязывает id', async () => {
    const profileId = freshProfileId();
    const client = makeClient({
      createNote: fn().mockResolvedValue(42),
      listNotes: fn().mockResolvedValue([serverNote(42, '2026-01-10 10:00:00')]),
    });
    const ctx = makeCtx(makeClient(), profileId, false);
    const tempId = await repoCreateNote(ctx, { heading: 'Новая', content: 'текст' });
    // правка до синхронизации сливается в create
    await repoUpdateNote(ctx, tempId, { content: 'текст новее' });

    await syncNow(client, profileId);
    expect(client.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ heading: 'Новая', content: 'текст новее' }),
    );

    const data = await loadOfflineData(profileId);
    expect(data.pending).toHaveLength(0);
    expect(data.aliases[String(tempId)]).toBe(42);
    // старый временный id продолжает разрешаться (открытый редактор)
    const note = await repoGetNote(makeCtx(makeClient(), profileId, false), tempId);
    expect(note.id).toBe(42);
  });
});
