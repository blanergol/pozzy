import { AISettings } from '../storage/settings';

/** Message in the OpenAI chat/completions wire format (including tool messages). */
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

/** Tool definition for function calling (JSON Schema of the parameters). */
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
  // guardrail: the request must not hang forever
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
    // body is not JSON — handled below based on the status
  }

  if (!response.ok) {
    throw new ChatError(data.error?.message || `HTTP ${response.status}`, response.status);
  }
  return data;
}

/**
 * A single call to an OpenAI-compatible /chat/completions.
 * When tools are passed, the model may return tool_calls instead of text.
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

/** Simple request/response without tools (backward compatibility). */
export async function sendChatMessage(
  settings: AISettings,
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
): Promise<string> {
  const reply = await callChatCompletion(settings, messages);
  if (!reply.content?.trim()) throw new ChatError('empty');
  return reply.content;
}

/**
 * OCR via a vision model of the same OpenAI-compatible API used for chat:
 * the image is sent as base64 in image_url, the model returns the recognized text.
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
