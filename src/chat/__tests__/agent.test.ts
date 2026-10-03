import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { runAgent } from '../agent';
import { callChatCompletion } from '../../api/chat';
import { PoznoteClient } from '../../api/client';
import { AISettings } from '../../storage/settings';

// Mock the LLM layer: the agent loop is tested against scripted replies
jest.mock('../../api/chat', () => ({
  callChatCompletion: jest.fn(),
}));

const mockedCall = callChatCompletion as jest.MockedFunction<typeof callChatCompletion>;

const settings: AISettings = { enabled: true, baseUrl: 'http://mock', apiKey: 'k', model: 'm' };

const getNoteMock = jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({ id: 1, heading: 'N', content: 'x' });

const fakeClient = {
  listNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
  getNote: getNoteMock,
  deleteNote: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue(undefined),
  searchNotes: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue([]),
} as unknown as PoznoteClient;

const history = [{ role: 'user' as const, content: 'привет' }];

function textReply(content: string) {
  return { content, toolCalls: [] };
}

function toolReply(name: string, args: unknown, id = 'call_1') {
  return { content: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }] };
}

describe('runAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('простой ответ без вызова инструментов', async () => {
    mockedCall.mockResolvedValueOnce(textReply('готово'));
    const reply = await runAgent(settings, fakeClient, history);
    expect(reply).toBe('готово');
    expect(mockedCall).toHaveBeenCalledTimes(1);
  });

  it('инструмент выполняется, результат уходит обратно в модель', async () => {
    mockedCall
      .mockResolvedValueOnce(toolReply('search_notes', { query: 'a' }))
      .mockResolvedValueOnce(textReply('нашёл'));
    const onTool = jest.fn();
    const reply = await runAgent(settings, fakeClient, history, { onTool });
    expect(reply).toBe('нашёл');
    expect(onTool).toHaveBeenCalledWith('search_notes');
    expect(fakeClient.listNotes).toHaveBeenCalled();
    // the second call has the tool result in its history
    const secondMessages = mockedCall.mock.calls[1][1];
    expect(secondMessages.some((m) => m.role === 'tool' && m.tool_call_id === 'call_1')).toBe(true);
  });

  it('неизвестный инструмент → ошибка в tool-результате', async () => {
    mockedCall
      .mockResolvedValueOnce(toolReply('no_such_tool', {}))
      .mockResolvedValueOnce(textReply('ок'));
    await runAgent(settings, fakeClient, history);
    const secondMessages = mockedCall.mock.calls[1][1];
    const toolMsg = secondMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('unknown tool');
  });

  it('approval: отказ пользователя — инструмент НЕ выполняется', async () => {
    mockedCall
      .mockResolvedValueOnce(toolReply('delete_note', { note_id: 1 }))
      .mockResolvedValueOnce(textReply('отменено'));
    const reply = await runAgent(settings, fakeClient, history, {
      requestApproval: async () => false,
    });
    expect(reply).toBe('отменено');
    expect(fakeClient.deleteNote).not.toHaveBeenCalled();
    const secondMessages = mockedCall.mock.calls[1][1];
    const toolMsg = secondMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('user rejected');
  });

  it('approval: разрешение — инструмент выполняется', async () => {
    mockedCall
      .mockResolvedValueOnce(toolReply('delete_note', { note_id: 1 }))
      .mockResolvedValueOnce(textReply('удалено'));
    await runAgent(settings, fakeClient, history, {
      requestApproval: async () => true,
    });
    expect(fakeClient.deleteNote).toHaveBeenCalledWith(1);
  });

  it('guardrail: 3 одинаковых вызова подряд → стоп и финальный ответ', async () => {
    mockedCall
      .mockResolvedValueOnce(toolReply('search_notes', { q: 'x' }, 'c1'))
      .mockResolvedValueOnce(toolReply('search_notes', { q: 'x' }, 'c2'))
      .mockResolvedValueOnce(toolReply('search_notes', { q: 'x' }, 'c3'))
      .mockResolvedValueOnce(textReply('стоп'));
    const reply = await runAgent(settings, fakeClient, history);
    expect(reply).toBe('стоп');
    const guardMessages = mockedCall.mock.calls[3][1];
    const lastToolMsg = [...guardMessages].reverse().find((m) => m.role === 'tool');
    expect(lastToolMsg?.content).toContain('identical call repeated');
  });

  it('guardrail: длинный результат инструмента обрезается', async () => {
    getNoteMock.mockResolvedValueOnce({
      id: 1,
      heading: 'N',
      content: 'x'.repeat(20000),
    });
    mockedCall
      .mockResolvedValueOnce(toolReply('get_note', { note_id: 1 }))
      .mockResolvedValueOnce(textReply('ок'));
    await runAgent(settings, fakeClient, history);
    const secondMessages = mockedCall.mock.calls[1][1];
    const toolMsg = secondMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.content?.length).toBeLessThan(8500);
    expect(toolMsg?.content).toContain('truncated');
  });

  it('память подмешивается в системный промпт', async () => {
    mockedCall.mockResolvedValueOnce(textReply('ок'));
    await runAgent(settings, fakeClient, history, {}, 'ранее говорили о docker');
    const firstMessages = mockedCall.mock.calls[0][1];
    expect(firstMessages[0].role).toBe('system');
    expect(firstMessages[0].content).toContain('ранее говорили о docker');
  });

  it('лимит шагов: после него — финальный вызов без инструментов', async () => {
    for (let i = 0; i < 8; i += 1) {
      mockedCall.mockResolvedValueOnce(toolReply('search_notes', { q: `q${i}` }, `c${i}`));
    }
    mockedCall.mockResolvedValueOnce(textReply('финал'));
    const reply = await runAgent(settings, fakeClient, history);
    expect(reply).toBe('финал');
    // 8 steps with tools + the final call without specs
    expect(mockedCall).toHaveBeenCalledTimes(9);
    expect(mockedCall.mock.calls[8][2]).toBeUndefined();
  });
});
