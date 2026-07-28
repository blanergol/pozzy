/**
 * Собирает абсолютную публичную ссылку из ответа share-эндпоинтов Poznote.
 * Сервер возвращает URL'ы в scheme-relative виде с хостом: //host/token,
 * //host/public_note.php?token=… — поэтому baseUrl конкатенировать нельзя
 * (получится дубль хоста). Предпочитаем формат public_note.php?token= —
 * это реальный файл, который маршрутизируется любым прокси (красивый путь
 * /{token} требует специального rewrite и не везде работает).
 */
export function buildShareUrl(
  status: { url?: string; url_query?: string },
  baseUrl: string,
): string {
  const raw = status.url_query || status.url || '';
  if (!raw) return baseUrl;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) {
    const scheme = baseUrl.split('://')[0] || 'https';
    return `${scheme}:${raw}`;
  }
  if (raw.startsWith('/')) return baseUrl + raw;
  return `${baseUrl}/${raw}`;
}
