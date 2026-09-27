import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearChatHistory,
  loadChatHistory,
  loadChatSummary,
  saveChatHistory,
  saveChatSummary,
  StoredChatMessage,
} from '../chatHistory';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

function msg(id: string, role: StoredChatMessage['role'] = 'user'): StoredChatMessage {
  return { id, role, content: `text ${id}` };
}

describe('chatHistory storage', () => {
  beforeEach(() => {
    AsyncStorage.clear();
  });

  it('пустое хранилище → пустой массив', async () => {
    expect(await loadChatHistory()).toEqual([]);
  });

  it('round-trip истории', async () => {
    await saveChatHistory([msg('1'), msg('2', 'assistant'), msg('3', 'tool')]);
    const loaded = await loadChatHistory();
    expect(loaded.map((m) => m.id)).toEqual(['1', '2', '3']);
  });

  it('битые данные фильтруются', async () => {
    await AsyncStorage.setItem(
      'poznote.chatHistory.v1',
      JSON.stringify([msg('1'), { id: 5 }, { role: 'user' }, null, 'junk']),
    );
    const loaded = await loadChatHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('1');
  });

  it('невалидный JSON → пустой массив без падения', async () => {
    await AsyncStorage.setItem('poznote.chatHistory.v1', '{broken');
    expect(await loadChatHistory()).toEqual([]);
  });

  it('кап 200 сообщений: хранятся последние', async () => {
    const many = Array.from({ length: 250 }, (_, i) => msg(String(i + 1)));
    await saveChatHistory(many);
    const loaded = await loadChatHistory();
    expect(loaded).toHaveLength(200);
    expect(loaded[0].id).toBe('51');
    expect(loaded[199].id).toBe('250');
  });

  it('саммари: дефолт, round-trip, очистка вместе с историей', async () => {
    expect(await loadChatSummary()).toEqual({ summary: '', coveredCount: 0 });
    await saveChatSummary({ summary: 'память', coveredCount: 8 });
    expect(await loadChatSummary()).toEqual({ summary: 'память', coveredCount: 8 });
    await clearChatHistory();
    expect(await loadChatHistory()).toEqual([]);
    expect(await loadChatSummary()).toEqual({ summary: '', coveredCount: 0 });
  });
});
