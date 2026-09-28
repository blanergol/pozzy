import AsyncStorage from '@react-native-async-storage/async-storage';
import { dateLocale, Locale, TranslationKey } from '../i18n';

/** Шаблон заметки. builtin-шаблоны живут в коде, пользовательские — в AsyncStorage. */
export interface NoteTemplate {
  id: string;
  name: string;
  heading: string;
  content: string;
  type?: 'note' | 'markdown' | 'tasklist';
  builtin?: boolean;
}

const TEMPLATES_KEY = 'pozzy.templates.v1';

function makeId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

type TFunction = (key: TranslationKey) => string;

/** Встроенные шаблоны; имена и содержимое локализованы через i18n. */
export function getBuiltinTemplates(t: TFunction): NoteTemplate[] {
  return [
    {
      id: 'builtin.daily',
      name: t('templates.builtinDaily'),
      heading: '{date}',
      content: t('templates.builtinDailyContent'),
      type: 'markdown',
      builtin: true,
    },
    {
      id: 'builtin.meeting',
      name: t('templates.builtinMeeting'),
      heading: t('templates.builtinMeeting') + ' {date}',
      content: t('templates.builtinMeetingContent'),
      type: 'markdown',
      builtin: true,
    },
    {
      id: 'builtin.shopping',
      name: t('templates.builtinShopping'),
      heading: t('templates.builtinShopping'),
      content: t('templates.builtinShoppingContent'),
      type: 'markdown',
      builtin: true,
    },
  ];
}

/** Подстановка плейсхолдеров {date}, {time}, {datetime} в заголовке и тексте. */
export function applyPlaceholders(text: string, locale: Locale): string {
  const loc = dateLocale(locale);
  const now = new Date();
  return text
    .replace(/\{datetime\}/g, now.toLocaleString(loc, { dateStyle: 'medium', timeStyle: 'short' }))
    .replace(/\{date\}/g, now.toLocaleDateString(loc, { dateStyle: 'long' }))
    .replace(/\{time\}/g, now.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' }));
}

// ===== Пользовательские шаблоны =====

export async function loadTemplates(): Promise<NoteTemplate[]> {
  try {
    const raw = await AsyncStorage.getItem(TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as NoteTemplate[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (tpl) => tpl && typeof tpl.id === 'string' && typeof tpl.name === 'string',
    );
  } catch {
    return [];
  }
}

/** Создать или обновить (по id) пользовательский шаблон. */
export async function saveTemplate(
  template: Omit<NoteTemplate, 'id' | 'builtin'> & { id?: string },
): Promise<NoteTemplate> {
  const list = await loadTemplates();
  const saved: NoteTemplate = { ...template, id: template.id ?? makeId() };
  const idx = list.findIndex((tpl) => tpl.id === saved.id);
  if (idx >= 0) {
    list[idx] = saved;
  } else {
    list.push(saved);
  }
  await AsyncStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
  return saved;
}

export async function deleteTemplate(id: string): Promise<void> {
  const list = await loadTemplates();
  await AsyncStorage.setItem(
    TEMPLATES_KEY,
    JSON.stringify(list.filter((tpl) => tpl.id !== id)),
  );
}
