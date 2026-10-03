import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { callChatCompletion, ChatError } from '../chat';
import { AISettings } from '../../storage/settings';

const settings: AISettings = { enabled: true, baseUrl: 'http://mock/v1/', apiKey: 'k', model: 'm' };

function mockFetch(payload: unknown, ok = true, status = 200) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    status,
    json: async () => payload,
  } as never);
}

describe('callChatCompletion', () => {
  beforeEach(() => {
    global.fetch = jest.fn() as never;
  });

  it('текстовый ответ без инструментов', async () => {
    mockFetch({ choices: [{ message: { content: 'привет' } }] });
    const reply = await callChatCompletion(settings, [{ role: 'user', content: 'hi' }]);
    expect(reply).toEqual({ content: 'привет', toolCalls: [] });
    // baseUrl is normalized (no trailing slash)
    expect(global.fetch).toHaveBeenCalledWith(
      'http://mock/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('ответ с tool_calls парсится в плоский вид', async () => {
    mockFetch({
      choices: [{
        message: {
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'search_notes', arguments: '{"query":"a"}' } },
          ],
        },
      }],
    });
    const reply = await callChatCompletion(settings, [{ role: 'user', content: 'x' }], [
      { name: 'search_notes', description: 'd', parameters: {} },
    ]);
    expect(reply.content).toBeNull();
    expect(reply.toolCalls).toEqual([{ id: 'c1', name: 'search_notes', arguments: '{"query":"a"}' }]);
  });

  it('при переданных tools тело содержит function specs и tool_choice', async () => {
    mockFetch({ choices: [{ message: { content: 'ok' } }] });
    await callChatCompletion(settings, [{ role: 'user', content: 'x' }], [
      { name: 't1', description: 'd', parameters: { type: 'object' } },
    ]);
    const body = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as { body: string }).body);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 't1', description: 'd', parameters: { type: 'object' } } }]);
    expect(body.tool_choice).toBe('auto');
  });

  it('HTTP-ошибка → ChatError со статусом', async () => {
    mockFetch({ error: { message: 'bad key' } }, false, 401);
    await expect(callChatCompletion(settings, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      name: 'ChatError',
      status: 401,
      message: 'bad key',
    });
  });

  it('пустой ответ → ChatError empty', async () => {
    mockFetch({ choices: [{ message: { content: '' } }] });
    await expect(callChatCompletion(settings, [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      message: 'empty',
    });
  });

  it('сетевая ошибка → ChatError network', async () => {
    (global.fetch as jest.Mock).mockRejectedValueOnce(new Error('boom') as never);
    await expect(callChatCompletion(settings, [{ role: 'user', content: 'x' }])).rejects.toBeInstanceOf(ChatError);
  });
});
