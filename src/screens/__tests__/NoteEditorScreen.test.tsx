import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { jest, describe, it, expect } from '@jest/globals';
import NoteEditorScreen from '../NoteEditorScreen';

// Mock the settings context: a fake client with server-like responses
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
      aiSettings: { enabled: false, baseUrl: '', apiKey: '', model: '' },
    }),
  };
});

// Mock connectivity: always "online" in the test
jest.mock('../../context/ConnectivityContext', () => ({
  useConnectivity: () => ({
    isOnline: true,
    reportNetworkError: jest.fn(),
    reportSuccess: jest.fn(),
  }),
}));

// offlineStore (the repository) needs AsyncStorage; jest has no native module
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Mock DialogProvider: the screen uses useDialog and the test has no provider
jest.mock('../../components/DialogProvider', () => ({
  useDialog: () => ({
    alert: jest.fn(),
    confirm: jest.fn(async () => true),
    prompt: jest.fn(async () => null),
  }),
}));

// Mock safe-area: the test has no SafeAreaProvider
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
    // let the load()/acquireLock() promises settle
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const json = tree!.toJSON();
    expect(json).toBeTruthy();
    // the note content made it into the TextInput
    const flat = JSON.stringify(json);
    expect(flat).toContain('Привет, мир');
    // unmount: clears the lock heartbeat intervals, otherwise jest won't exit
    await act(async () => {
      tree!.unmount();
    });
  });
});
