import { AISettings } from '../storage/settings';

/** Сообщение в wire-формате OpenAI chat/completions (включая tool-сообщения). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ChatToolCallWire[];
  tool_call_id?: string;
}

export interface ChatToolCallWire {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Описание инструмента для function calling (JSON Schema параметров). */
export interface ChatToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ChatError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: ChatToolCallWire[];
    };
  }[];
  error?: { message?: string };
}

export interface AssistantReply {
  content: string | null;
  toolCalls: ChatToolCall[];
}

async function postChatCompletion(
  settings: AISettings,
  body: Record<string, unknown>,
): Promise<ChatCompletionResponse> {
  const baseUrl = settings.baseUrl.replace(/\/+$/, '');
  // guardrail: запрос не должен висеть вечно
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw new ChatError('network');
  } finally {
    clearTimeout(timeout);
  }

  let data: ChatCompletionResponse = {};
  try {
    data = (await response.json()) as ChatCompletionResponse;
  } catch {
    // тело не JSON — обработаем ниже по статусу
  }

  if (!response.ok) {
    throw new ChatError(data.error?.message || `HTTP ${response.status}`, response.status);
  }
  return data;
}

/**
 * Один вызов OpenAI-совместимого /chat/completions.
 * При переданных tools модель может вернуть tool_calls вместо текста.
 */
export async function callChatCompletion(
  settings: AISettings,
  messages: ChatMessage[],
  tools?: ChatToolSpec[],
): Promise<AssistantReply> {
  const body: Record<string, unknown> = { model: settings.model, messages };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({ type: 'function', function: t }));
    body.tool_choice = 'auto';
  }

  const data = await postChatCompletion(settings, body);
  const message = data.choices?.[0]?.message;
  if (!message) throw new ChatError('empty');

  const toolCalls: ChatToolCall[] = (message.tool_calls ?? [])
    .filter((c) => c.type === 'function' && c.function?.name)
    .map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments ?? '{}' }));

  const content = typeof message.content === 'string' ? message.content : null;
  if (!toolCalls.length && !content?.trim()) throw new ChatError('empty');
  return { content, toolCalls };
}

/** Простой запрос-ответ без инструментов (обратная совместимость). */
export async function sendChatMessage(
  settings: AISettings,
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
): Promise<string> {
  const reply = await callChatCompletion(settings, messages);
  if (!reply.content?.trim()) throw new ChatError('empty');
  return reply.content;
}

/**
 * OCR через vision-модель того же OpenAI-совместимого API, что и чат:
 * картинка уходит base64 в image_url, модель возвращает распознанный текст.
 */
export async function extractTextFromImage(
  settings: AISettings,
  base64: string,
  mimeType: string,
): Promise<string> {
  const data = await postChatCompletion(settings, {
    model: settings.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Extract all text from this image verbatim, preserving line breaks. Output only the recognized text, without any commentary or markdown fences.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${base64}` },
          },
        ],
      },
    ],
  });
  const content = data.choices?.[0]?.message?.content;
  if (!content?.trim()) throw new ChatError('empty');
  return content.trim();
}
