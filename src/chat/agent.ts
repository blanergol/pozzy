import { PoznoteClient } from '../api/client';
import { callChatCompletion, ChatMessage, ChatToolCallWire } from '../api/chat';
import { AISettings } from '../storage/settings';
import { POZNOTE_TOOLS } from './tools';

const MAX_STEPS = 8;
/** guardrails: общий лимит вызовов инструментов за один запрос */
const MAX_TOOL_CALLS = 25;
/** guardrails: повтор одного и того же вызова подряд — модель зациклилась */
const MAX_IDENTICAL_CALLS = 3;
/** guardrails: обрезка слишком больших результатов инструментов (защита контекста) */
const TOOL_RESULT_MAX_CHARS = 8000;

const SYSTEM_PROMPT = [
  'You are an AI assistant inside a note-taking app (Poznote).',
  'You can search, read, create, edit, move and delete the user\'s notes via the provided tools.',
  'Rules:',
  '- To act on a note by its title, first find it with search_notes; never invent note ids.',
  '- Answer in the same language as the user.',
  '- Keep answers concise; format note lists compactly.',
  '- If a tool returns an error, explain it briefly instead of retrying blindly.',
  '- Never retry a call with identical arguments after an error.',
  '- Before batch operations, state how many notes will be affected.',
].join('\n');

export interface ApprovalRequest {
  toolName: string;
  /** Готовый локализованный текст для карточки подтверждения. */
  preview: string;
}

export interface AgentCallbacks {
  /** Вызывается перед выполнением каждого инструмента (для индикатора в UI). */
  onTool?: (toolName: string) => void;
  /** Должен вернуть true, если пользователь разрешил действие. */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
}

function toWireToolCalls(toolCalls: { id: string; name: string; arguments: string }[]): ChatToolCallWire[] {
  return toolCalls.map((c) => ({
    id: c.id,
    type: 'function' as const,
    function: { name: c.name, arguments: c.arguments },
  }));
}

/**
 * Агентский цикл: модель ↔ инструменты Poznote, максимум MAX_STEPS шагов.
 * Возвращает финальный текстовый ответ ассистента.
 */
export async function runAgent(
  settings: AISettings,
  client: PoznoteClient,
  history: { role: 'user' | 'assistant'; content: string }[],
  callbacks: AgentCallbacks = {},
  memory?: string,
): Promise<string> {
  const systemPrompt = memory
    ? `${SYSTEM_PROMPT}\n\nLong-term memory — summary of the earlier conversation:\n${memory}`
    : SYSTEM_PROMPT;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  const specs = POZNOTE_TOOLS.map((t) => t.spec);
  let toolCallCount = 0;
  let lastCallSignature = '';
  let identicalCallStreak = 0;
  let guardrailStop = false;

  for (let step = 0; step < MAX_STEPS && !guardrailStop; step++) {
    const reply = await callChatCompletion(settings, messages, specs);

    if (reply.toolCalls.length === 0) {
      if (reply.content?.trim()) return reply.content;
      break;
    }

    messages.push({
      role: 'assistant',
      content: reply.content,
      tool_calls: toWireToolCalls(reply.toolCalls),
    });

    for (const call of reply.toolCalls) {
      // guardrail: общий бюджет вызовов на запрос
      toolCallCount += 1;
      if (toolCallCount > MAX_TOOL_CALLS) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'guardrail: tool call budget exceeded, answer with what you have' }),
        });
        guardrailStop = true;
        break;
      }

      // guardrail: детект зацикливания — один и тот же вызов подряд
      const signature = `${call.name}:${call.arguments}`;
      identicalCallStreak = signature === lastCallSignature ? identicalCallStreak + 1 : 1;
      lastCallSignature = signature;
      if (identicalCallStreak >= MAX_IDENTICAL_CALLS) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'guardrail: identical call repeated, stop retrying and answer with what you have' }),
        });
        guardrailStop = true;
        break;
      }

      const tool = POZNOTE_TOOLS.find((t) => t.spec.name === call.name);
      let result: string | undefined;

      if (!tool) {
        result = JSON.stringify({ error: `unknown tool: ${call.name}` });
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          result = JSON.stringify({ error: 'invalid tool arguments' });
        }

        if (result === undefined && tool.requiresApproval) {
          let preview = call.name;
          try {
            preview = (await tool.approvalPreview?.(client, args)) ?? call.name;
          } catch {
            // превью не критично
          }
          const approved = callbacks.requestApproval
            ? await callbacks.requestApproval({ toolName: call.name, preview })
            : false;
          if (!approved) {
            result = JSON.stringify({ error: 'user rejected the action' });
          }
        }

        if (result === undefined) {
          callbacks.onTool?.(call.name);
          try {
            result = await tool.run(client, args);
          } catch (e) {
            result = JSON.stringify({ error: String(e instanceof Error ? e.message : e).slice(0, 300) });
          }
        }
      }

      // guardrail: защита контекста от гигантских результатов
      let finalResult = result ?? '';
      if (finalResult.length > TOOL_RESULT_MAX_CHARS) {
        finalResult = `${finalResult.slice(0, TOOL_RESULT_MAX_CHARS)}\n… [truncated, ${finalResult.length} chars total]`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: finalResult });
    }
  }

  // Лимит шагов или пустой ответ: финальный вызов без инструментов
  const final = await callChatCompletion(settings, messages);
  return final.content ?? '';
}
