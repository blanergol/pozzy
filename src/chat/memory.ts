import { callChatCompletion } from '../api/chat';
import { loadChatSummary, saveChatSummary } from '../storage/chatHistory';
import { AISettings } from '../storage/settings';

/**
 * Память агента, базовая реализация:
 * - краткосрочная: последние WINDOW сообщений отправляются в LLM как есть;
 * - долгосрочная: более старые сообщения схлопываются в саммари (тем же LLM)
 *   и подмешиваются в системный промпт.
 * Саммари пересчитывается только когда накопилось >= SUMMARIZE_AFTER новых
 * старых сообщений — не на каждый запрос.
 */

const WINDOW = 12;
const SUMMARIZE_AFTER = 6;
/** Маркер служебного запроса — по нему мок/e2e отличают саммаризацию от обычного чата. */
const SUMMARY_PROMPT_PREFIX = 'SUMMARIZE_CONVERSATION';

export interface MemoryContext {
  /** История для отправки (последние WINDOW сообщений). */
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Саммари старых сообщений для системного промпта (если есть). */
  summary?: string;
}

type HistoryMessage = { role: 'user' | 'assistant'; content: string };

function buildSummaryPrompt(previous: string, newMessages: HistoryMessage[]): string {
  const dump = newMessages
    .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
    .join('\n')
    .slice(0, 4000);
  return [
    SUMMARY_PROMPT_PREFIX,
    'Update the running summary of this conversation. Keep it under 150 words.',
    'Preserve key facts: user preferences, note titles mentioned, actions taken, pending requests.',
    "Write the summary in the conversation's language.",
    previous ? `Previous summary:\n${previous}` : 'No previous summary.',
    `New messages to incorporate:\n${dump}`,
  ].join('\n\n');
}

export async function buildMemoryContext(
  settings: AISettings,
  fullHistory: HistoryMessage[],
): Promise<MemoryContext> {
  if (fullHistory.length <= WINDOW) return { history: fullHistory };

  const windowed = fullHistory.slice(-WINDOW);
  const olderCount = fullHistory.length - WINDOW;

  try {
    const stored = await loadChatSummary();
    const freshCount = olderCount - stored.coveredCount;

    // саммари актуально или накопилось мало нового — используем как есть
    if (freshCount < SUMMARIZE_AFTER) {
      return { history: windowed, summary: stored.summary || undefined };
    }

    const reply = await callChatCompletion(settings, [
      {
        role: 'user',
        content: buildSummaryPrompt(stored.summary, fullHistory.slice(stored.coveredCount, olderCount)),
      },
    ]);
    const summary = reply.content?.trim() || stored.summary;
    await saveChatSummary({ summary, coveredCount: olderCount });
    return { history: windowed, summary: summary || undefined };
  } catch {
    // память — вспомогательная фича: при сбое просто работаем без саммари
    return { history: windowed };
  }
}
