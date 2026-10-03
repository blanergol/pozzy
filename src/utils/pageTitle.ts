/** Web page title for a note created via "share link" (client-side feature, no server). */
export async function fetchPageTitle(url: string): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let html: string;
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'text/html' } });
      html = (await res.text()).slice(0, 200_000);
    } finally {
      clearTimeout(timer);
    }
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match) return null;
    const title = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
    return title || null;
  } catch {
    return null;
  }
}
