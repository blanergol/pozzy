import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { jest, describe, it, expect } from '@jest/globals';
import NoteEditorScreen from '../NoteEditorScreen';

// Мокаем контекст настроек: фейковый клиент с ответами «как у сервера»
jest.mock('../../context/SettingsContext', () => {
  const note = {
    id: 1,
    heading: 'Тестовая заметка',
    workspace: 'Personal',
    type: 'note',
    tags: 'тег1,тест',
    folder: 'Проекты',
    folder_id: 5,
    linked_note_id: null,
    icon: null,
    icon_color: null,
    color: null,
    color_hex: null,
    created: '2026-07-26 12:00:00',
    updated: '2026-07-27 12:00:00',
    reminder_at: '2026-07-30 09:00:00',
    content: '<p>Привет, мир!</p>',
  };
  const fn = () => jest.fn<(...args: any[]) => Promise<any>>();
  const client: any = {
    getNote: fn().mockResolvedValue(note),
    acquireLock: fn().mockResolvedValue(undefined),
    heartbeatLock: fn().mockResolvedValue(undefined),
    releaseLock: fn().mockResolvedValue(undefined),
    updateNote: fn().mockResolvedValue(undefined),
    toggleFavorite: fn().mockResolvedValue(undefined),
    deleteNote: fn().mockResolvedValue(undefined),
    duplicateNote: fn().mockResolvedValue(2),
    convertNote: fn().mockResolvedValue(undefined),
    getShareStatus: fn().mockResolvedValue({ success: true, public: false }),
    setNoteReminder: fn().mockResolvedValue(undefined),
    deleteNoteReminder: fn().mockResolvedValue(undefined),
    listSnapshots: fn().mockResolvedValue([]),
    getBacklinks: fn().mockResolvedValue([]),
    listFolders: fn().mockResolvedValue([]),
    moveNoteToFolder: fn().mockResolvedValue(undefined),
    removeNoteFromFolder: fn().mockResolvedValue(undefined),
  };
  return {
    useSettings: () => ({
      settings: { baseUrl: 'http://mock', username: 'admin', password: 'x', userId: '1' },
      client,
      isLoading: false,
      workspace: null,
      setWorkspace: jest.fn(),
      save: jest.fn(),
      reset: jest.fn(),
    }),
  };
});

// Мокаем DialogProvider: экран использует useDialog, в тесте провайдера нет
jest.mock('../../components/DialogProvider', () => ({
  useDialog: () => ({
    alert: jest.fn(),
    confirm: jest.fn(async () => true),
    prompt: jest.fn(async () => null),
  }),
}));

// Мокаем safe-area: в тесте нет SafeAreaProvider
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const navigation: any = {
  setOptions: jest.fn(),
  navigate: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
  goBack: jest.fn(),
  reset: jest.fn(),
};
const route: any = { params: { noteId: 1, favorite: 0 } };

describe('NoteEditorScreen', () => {
  it('рендерится после загрузки заметки без ошибок', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(<NoteEditorScreen navigation={navigation} route={route} />);
    });
    // даём промисам load()/acquireLock() завершиться
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const json = tree!.toJSON();
    expect(json).toBeTruthy();
    // контент заметки попал в TextInput
    const flat = JSON.stringify(json);
    expect(flat).toContain('Привет, мир');
    // размонтируем: очистит интервалы heartbeat блокировки, иначе jest не завершится
    await act(async () => {
      tree!.unmount();
    });
  });
});
