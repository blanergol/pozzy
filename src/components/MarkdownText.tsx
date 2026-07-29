import React from 'react';
import { Linking, Platform, StyleSheet, Text, TextStyle, View } from 'react-native';
import { ThemeColors } from '../theme/ThemeContext';

/**
 * Лёгкий рендерер markdown-подмножества для сообщений ассистента:
 * заголовки, списки, цитаты, блоки кода, **bold**, *italic*, `code`, [links](url).
 * Без внешних зависимостей — работает на всех платформах (web/iOS/Android).
 */

interface InlineSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

const INLINE_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\))/g;

function parseInline(text: string): InlineSpan[] {
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

type Block =
  | { type: 'code'; content: string }
  | { type: 'heading'; level: number; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; content: string }
  | { type: 'paragraph'; content: string };

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const UL_ITEM_RE = /^\s*[-*]\s+(.+)$/;
const OL_ITEM_RE = /^\s*\d+[.)]\s+(.+)$/;
const QUOTE_RE = /^>\s?(.*)$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;

  const flushParagraph = (acc: string[]) => {
    if (acc.length > 0) blocks.push({ type: 'paragraph', content: acc.join('\n') });
  };

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
    flushParagraph(paraLines);
  }

  return blocks;
}

const monoFont = Platform.select({ ios: 'Menlo', default: 'monospace' });

interface Props {
  text: string;
  colors: ThemeColors;
  style?: TextStyle;
}

export default function MarkdownText({ text, colors, style }: Props) {
  const renderInline = (content: string, keyPrefix: string) =>
    parseInline(content).map((span, i) => (
      <Text
        key={`${keyPrefix}-${i}`}
        style={[
          span.bold && styles.bold,
          span.italic && styles.italic,
          span.code && [styles.inlineCode, { backgroundColor: colors.inputBg, color: colors.text }],
          span.link && { color: colors.accent, textDecorationLine: 'underline' as const },
        ]}
        onPress={span.link ? () => Linking.openURL(span.link as string).catch(() => {}) : undefined}
      >
        {span.text}
      </Text>
    ));

  return (
    <View>
      {parseBlocks(text).map((block, index) => {
        const key = `b${index}`;
        switch (block.type) {
          case 'code':
            return (
              <View key={key} style={[styles.codeBlock, { backgroundColor: colors.inputBg }]}>
                <Text style={[styles.codeText, { color: colors.text }]}>{block.content}</Text>
              </View>
            );
          case 'heading':
            return (
              <Text
                key={key}
                style={[styles.heading, { color: colors.text, fontSize: 19 - Math.min(block.level, 3) }, style]}
              >
                {renderInline(block.content, key)}
              </Text>
            );
          case 'list':
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, itemIndex) => (
                  <View key={`${key}-${itemIndex}`} style={styles.listItem}>
                    <Text style={[styles.bullet, { color: colors.textSecondary }, style]}>
                      {block.ordered ? `${itemIndex + 1}.` : '•'}
                    </Text>
                    <Text style={[styles.listText, { color: colors.text }, style]}>
                      {renderInline(item, `${key}-${itemIndex}`)}
                    </Text>
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={key} style={[styles.quote, { borderLeftColor: colors.border }]}>
                <Text style={[styles.quoteText, { color: colors.textSecondary }, style]}>
                  {renderInline(block.content, key)}
                </Text>
              </View>
            );
          default:
            return (
              <Text key={key} style={[styles.paragraph, { color: colors.text }, style]}>
                {renderInline(block.content, key)}
              </Text>
            );
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  paragraph: { fontSize: 15, lineHeight: 22, marginVertical: 2 },
  heading: { fontWeight: '700', marginTop: 8, marginBottom: 4 },
  list: { marginVertical: 2 },
  listItem: { flexDirection: 'row', alignItems: 'flex-start', marginVertical: 1 },
  bullet: { width: 18, fontSize: 15, lineHeight: 22 },
  listText: { flex: 1, fontSize: 15, lineHeight: 22 },
  quote: { borderLeftWidth: 3, paddingLeft: 10, marginVertical: 4 },
  quoteText: { fontSize: 15, lineHeight: 22, fontStyle: 'italic' },
  inlineCode: {
    fontFamily: monoFont,
    fontSize: 13,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  codeBlock: { borderRadius: 8, padding: 10, marginVertical: 6 },
  codeText: { fontFamily: monoFont, fontSize: 13, lineHeight: 18 },
});
