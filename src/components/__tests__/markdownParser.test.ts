import { describe, it, expect } from '@jest/globals';
import { parseBlocks, parseInline } from '../markdownParser';

describe('parseInline', () => {
  it('плоский текст без разметки', () => {
    expect(parseInline('просто текст')).toEqual([{ text: 'просто текст' }]);
  });

  it('bold, italic, inline code', () => {
    expect(parseInline('а **б** в *г* д `е`')).toEqual([
      { text: 'а ' },
      { text: 'б', bold: true },
      { text: ' в ' },
      { text: 'г', italic: true },
      { text: ' д ' },
      { text: 'е', code: true },
    ]);
  });

  it('ссылка', () => {
    expect(parseInline('смотри [доку](https://example.com) тут')).toEqual([
      { text: 'смотри ' },
      { text: 'доку', link: 'https://example.com' },
      { text: ' тут' },
    ]);
  });

  it('одиночные звёздочки-спецсимволы не ломают парсер', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ text: '2 * 3 = 6' }]);
  });
});

describe('parseBlocks', () => {
  it('заголовки разных уровней', () => {
    const blocks = parseBlocks('# Раз\n## Два\n### Три');
    expect(blocks).toEqual([
      { type: 'heading', level: 1, content: 'Раз' },
      { type: 'heading', level: 2, content: 'Два' },
      { type: 'heading', level: 3, content: 'Три' },
    ]);
  });

  it('маркированный список', () => {
    expect(parseBlocks('- один\n- два')).toEqual([
      { type: 'list', ordered: false, items: ['один', 'два'] },
    ]);
  });

  it('нумерованный список', () => {
    expect(parseBlocks('1. раз\n2. два')).toEqual([
      { type: 'list', ordered: true, items: ['раз', 'два'] },
    ]);
  });

  it('блок кода с тройными кавычками', () => {
    const blocks = parseBlocks('текст\n```js\nconst a = 1;\nconst b = 2;\n```\nпосле');
    expect(blocks).toEqual([
      { type: 'paragraph', content: 'текст' },
      { type: 'code', content: 'const a = 1;\nconst b = 2;' },
      { type: 'paragraph', content: 'после' },
    ]);
  });

  it('цитата', () => {
    expect(parseBlocks('> первая\n> вторая')).toEqual([
      { type: 'quote', content: 'первая\nвторая' },
    ]);
  });

  it('абзацы разделены пустой строкой', () => {
    expect(parseBlocks('один\n\nдва')).toEqual([
      { type: 'paragraph', content: 'один' },
      { type: 'paragraph', content: 'два' },
    ]);
  });

  it('смешанный документ', () => {
    const blocks = parseBlocks('## Отчёт\n\nТекст с **жирным**.\n\n- пункт\n\n```\ncode\n```');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'code']);
  });
});
