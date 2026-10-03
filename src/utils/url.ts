/**
 * Builds an absolute public link from the response of Poznote's share endpoints.
 * The server returns URLs in scheme-relative form with a host: //host/token,
 * //host/public_note.php?token=… — so baseUrl must not be concatenated
 * (the host would be duplicated). We prefer the public_note.php?token= format —
 * it is a real file routed by any proxy (the pretty path /{token} requires
 * a special rewrite and does not work everywhere).
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
