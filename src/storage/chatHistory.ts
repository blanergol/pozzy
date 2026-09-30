import { APP_SCOPE, encryptedCache } from './secure/encryptedCache';

// История и саммари чата содержат текст заметок (ответы tools) — хранятся
// зашифрованными ключом приложения, на web — только в рамках сессии.

/** Сообщение чата для персистента хранилища (role: user/assistant/tool). */
export interface StoredChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export const CHAT_HISTORY_KEY = 'poznote.chatHistory.v1';
/** Максимум хранимых сообщений — старые обрезаются. */
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

// ===== Долгосрочная память: саммари старых сообщений =====

export interface ChatSummary {
  /** Текст саммари (пусто — памяти пока нет). */
  summary: string;
  /** Сколько ведущих сообщений истории покрыто саммари. */
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
