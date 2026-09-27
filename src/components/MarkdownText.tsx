import React from 'react';
import { Linking, Platform, StyleSheet, Text, TextStyle, View } from 'react-native';
import { ThemeColors } from '../theme/ThemeContext';
import { parseBlocks, parseInline } from './markdownParser';

/**
 * Рендерер markdown-подмножества для сообщений ассистента.
 * Парсинг — в ./markdownParser (чистые функции, покрыты тестами).
 */

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
