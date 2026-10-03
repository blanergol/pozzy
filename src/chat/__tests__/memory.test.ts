import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildMemoryContext } from '../memory';
import { AISettings } from '../../storage/settings';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

const settings: AISettings = { enabled: true, baseUrl: 'http://mock', apiKey: 'k', model: 'm' };

function makeHistory(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `msg ${i + 1}`,
  }));
}

function mockFetchOnce(summary: string) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    json: async () => ({ choices: [{ message: { content: summary } }] }),
  } as never);
}

describe('buildMemoryContext', () => {
  beforeEach(() => {
    AsyncStorage.clear();
    global.fetch = jest.fn() as never;
  });

  it('короткая история уходит целиком, без вызова LLM', async () => {
    const history = makeHistory(6);
    const ctx = await buildMemoryContext(settings, history);
    expect(ctx.history).toHaveLength(6);
    expect(ctx.summary).toBeUndefined();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('длинная история: окно 12 + саммаризация старых через LLM', async () => {
    mockFetchOnce('краткое саммари');
    const ctx = await buildMemoryContext(settings, makeHistory(20));
    expect(ctx.history).toHaveLength(12);
    expect(ctx.history[0].content).toBe('msg 9');
    expect(ctx.summary).toBe('краткое саммари');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('свежего материала мало — повторная саммаризация не вызывается', async () => {
    mockFetchOnce('краткое саммари');
    await buildMemoryContext(settings, makeHistory(20));
    // 21 messages: 9 old, 8 covered → 1 new < SUMMARIZE_AFTER
    const ctx = await buildMemoryContext(settings, makeHistory(21));
    expect(ctx.summary).toBe('краткое саммари');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('при сбое сети работаем без саммари', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('network') as never);
    const ctx = await buildMemoryContext(settings, makeHistory(20));
    expect(ctx.history).toHaveLength(12);
    expect(ctx.summary).toBeUndefined();
  });
});
