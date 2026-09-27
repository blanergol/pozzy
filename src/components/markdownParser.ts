/**
 * Парсер markdown-подмножества: заголовки, списки, цитаты, блоки кода,
 * **bold**, *italic*, `code`, [links](url). Чистые функции без React — для тестов.
 */

export interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g;

export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) spans.push({ text: text.slice(last, idx) });
    const token = match[0];
    if (token.startsWith('**')) spans.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('*')) spans.push({ text: token.slice(1, -1), italic: true });
    else if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), code: true });
    else {
      const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      spans.push(linkMatch ? { text: linkMatch[1], link: linkMatch[2] } : { text: token });
    }
    last = idx + token.length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

export type Block =
  | { type: 'code'; content: string }
  | { type: 'heading'; level: number; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'paragraph'; content: string };

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UL_ITEM_RE = /^\s*[-*]\s+(.+)$/;
const OL_ITEM_RE = /^\s*\d+[.)]\s+(.+)$/;
const QUOTE_RE = /^>\s?(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // блок кода ```
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // закрывающий ```
      blocks.push({ type: 'code', content: codeLines.join('\n') });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, content: heading[2] });
      i += 1;
      continue;
    }

    if (UL_ITEM_RE.test(line) || OL_ITEM_RE.test(line)) {
      const ordered = OL_ITEM_RE.test(line) && !UL_ITEM_RE.test(line);
      const items: string[] = [];
      while (
        i < lines.length &&
        ((ordered && OL_ITEM_RE.test(lines[i])) || (!ordered && UL_ITEM_RE.test(lines[i])))
      ) {
        const m = lines[i].match(ordered ? OL_ITEM_RE : UL_ITEM_RE);
        if (m) items.push(m[1]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const quote = line.match(QUOTE_RE);
    if (quote) {
      const quoteLines: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        const m = lines[i].match(QUOTE_RE);
        quoteLines.push(m ? m[1] : '');
        i += 1;
      }
      blocks.push({ type: 'quote', content: quoteLines.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // обычный абзац: склеиваем соседние непустые строки
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !HEADING_RE.test(lines[i]) &&
      !UL_ITEM_RE.test(lines[i]) &&
      !OL_ITEM_RE.test(lines[i]) &&
      !QUOTE_RE.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') });
    }
  }

  return blocks;
}
