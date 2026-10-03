import { APP_SCOPE, encryptedCache } from './secure/encryptedCache';

// Chat history and summary contain note text (tool responses) — they are stored
// encrypted with the app key; on web, only for the duration of the session.

/** Chat message as persisted in storage (role: user/assistant/tool). */
export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export const CHAT_HISTORY_KEY = 'poznote.chatHistory.v1';
/** Maximum number of stored messages — older ones are trimmed. */
const MAX_MESSAGES = 200;

export async function loadChatHistory(): Promise<StoredChatMessage[]> {
  try {
    const raw = await encryptedCache.get(APP_SCOPE, CHAT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredChatMessage[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m) =>
        m &&
        typeof m.id === 'string' &&
        (m.role === 'user' || m.role === 'assistant' || m.role === 'tool') &&
        typeof m.content === 'string',
    );
  } catch {
    return [];
  }
}

export async function saveChatHistory(messages: StoredChatMessage[]): Promise<void> {
  await encryptedCache.set(APP_SCOPE, CHAT_HISTORY_KEY, JSON.stringify(messages.slice(-MAX_MESSAGES)));
}

export async function clearChatHistory(): Promise<void> {
  await encryptedCache.deleteMany(APP_SCOPE, [CHAT_HISTORY_KEY, CHAT_SUMMARY_KEY]);
}

// ===== Long-term memory: summary of older messages =====

export interface ChatSummary {
  /** Summary text (empty — no memory yet). */
  summary: string;
  /** How many leading messages of the history the summary covers. */
  coveredCount: number;
}

export const CHAT_SUMMARY_KEY = 'poznote.chatSummary.v1';

export async function loadChatSummary(): Promise<ChatSummary> {
  try {
    const raw = await encryptedCache.get(APP_SCOPE, CHAT_SUMMARY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChatSummary>;
      return {
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
        coveredCount: typeof parsed.coveredCount === 'number' ? parsed.coveredCount : 0,
      };
    }
  } catch {
    // fallthrough
  }
  return { summary: '', coveredCount: 0 };
}

export async function saveChatSummary(summary: ChatSummary): Promise<void> {
  await encryptedCache.set(APP_SCOPE, CHAT_SUMMARY_KEY, JSON.stringify(summary));
}
