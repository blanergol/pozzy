import { callChatCompletion } from '../api/chat';
import { loadChatSummary, saveChatSummary } from '../storage/chatHistory';
import { AISettings } from '../storage/settings';

/**
 * Agent memory, basic implementation:
 * - short-term: the last WINDOW messages are sent to the LLM as is;
 * - long-term: older messages are collapsed into a summary (by the same LLM)
 *   and mixed into the system prompt.
 * The summary is recomputed only once >= SUMMARIZE_AFTER new old messages
 * have accumulated — not on every request.
 */

const WINDOW = 12;
const SUMMARIZE_AFTER = 6;
/** Marker of a service request — lets the mock/e2e tell summarization apart from regular chat. */
const SUMMARY_PROMPT_PREFIX = 'SUMMARIZE_CONVERSATION';

export interface MemoryContext {
  /** History to send (the last WINDOW messages). */
  history: { role: 'user' | 'assistant'; content: string }[];
  /** Summary of older messages for the system prompt (if any). */
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

    // the summary is up to date or too little is new — use it as is
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
    // memory is an auxiliary feature: on failure we simply work without a summary
    return { history: windowed };
  }
}
