import { describe, expect, it } from '@jest/globals';
import {
  DecryptError,
  ENVELOPE_PREFIX,
  decodeDataKey,
  decryptString,
  encryptString,
  generateDataKey,
  isEnvelope,
} from '../crypto';
import { base64FromBytes, base64ToBytes, utf8Decode, utf8Encode } from '../../../utils/base64';

const key = decodeDataKey(generateDataKey()) as Uint8Array;
const AD = 'pozzy.cache.p1.note.1';

function flipByte(envelope: string, index: number): string {
  const packed = base64ToBytes(envelope.slice(ENVELOPE_PREFIX.length));
  packed[index] ^= 0x01;
  return ENVELOPE_PREFIX + base64FromBytes(packed);
}

describe('crypto', () => {
  it('ключ данных — 256 бит из CSPRNG, каждый раз новый', () => {
    const a = generateDataKey();
    const b = generateDataKey();
    expect(decodeDataKey(a)).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(decodeDataKey('too-short')).toBeNull();
    expect(decodeDataKey(base64FromBytes(new Uint8Array(16)))).toBeNull();
  });

  it('round-trip, включая юникод и пустую строку', () => {
    for (const text of ['', 'hello', 'Привет, мир! \u{1F642} 日本語', 'x'.repeat(100_000)]) {
      const env = encryptString(key, text, AD);
      expect(isEnvelope(env)).toBe(true);
      expect(decryptString(key, env, AD)).toBe(text);
    }
  });

  it('конверт versioned и не содержит открытого текста', () => {
    const env = encryptString(key, 'секретная заметка', AD);
    expect(env.startsWith('enc:v1:')).toBe(true);
    expect(env).not.toContain('секрет');
  });

  it('случайный nonce: одинаковый текст даёт разный шифротекст', () => {
    expect(encryptString(key, 'same', AD)).not.toBe(encryptString(key, 'same', AD));
  });

  it('подменённый шифротекст, nonce и тег отклоняются', () => {
    const env = encryptString(key, 'payload', AD);
    const packedLength = base64ToBytes(env.slice(ENVELOPE_PREFIX.length)).length;
    for (const index of [0, 23, 24, packedLength - 1]) {
      expect(() => decryptString(key, flipByte(env, index), AD)).toThrow(DecryptError);
    }
  });

  it('associated data привязывает значение к ключу хранилища', () => {
    const env = encryptString(key, 'payload', AD);
    expect(() => decryptString(key, env, 'pozzy.cache.p1.note.2')).toThrow(DecryptError);
  });

  it('чужой ключ, обрезанный и битый конверт отклоняются без утечки данных', () => {
    const env = encryptString(key, 'payload-secret', AD);
    const other = decodeDataKey(generateDataKey()) as Uint8Array;
    const cases = [
      () => decryptString(other, env, AD),
      () => decryptString(key, env.slice(0, 20), AD),
      () => decryptString(key, 'enc:v1:@@@', AD),
      () => decryptString(key, 'plain text', AD),
    ];
    for (const run of cases) {
      let error: unknown = null;
      try {
        run();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(DecryptError);
      expect((error as Error).message).not.toContain('payload');
    }
  });

  it('base64 и utf8 кодеки симметричны', () => {
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37) % 256);
    for (const len of [0, 1, 2, 3, 4, 999, 1000]) {
      const slice = bytes.subarray(0, len);
      expect(Array.from(base64ToBytes(base64FromBytes(slice)))).toEqual(Array.from(slice));
    }
    const text = 'ёжик \u{1F994} test';
    expect(utf8Decode(utf8Encode(text))).toBe(text);
    expect(() => base64ToBytes('a')).toThrow();
  });

  it('запасные реализации без btoa/atob/TextEncoder/TextDecoder дают тот же результат', () => {
    const g = globalThis as Record<string, unknown>;
    const saved = { btoa: g.btoa, atob: g.atob, TextEncoder: g.TextEncoder, TextDecoder: g.TextDecoder };
    const bytes = new Uint8Array(5000).map((_, i) => (i * 131 + 7) % 256);
    const text = 'Проверка UTF-8: ёжик \u{1F994}, 日本語, ascii';
    const expectedB64 = base64FromBytes(bytes);
    const expectedUtf8 = Array.from(utf8Encode(text));
    try {
      delete g.btoa;
      delete g.atob;
      delete g.TextEncoder;
      delete g.TextDecoder;
      expect(base64FromBytes(bytes)).toBe(expectedB64);
      expect(Array.from(base64ToBytes(expectedB64))).toEqual(Array.from(bytes));
      expect(Array.from(utf8Encode(text))).toEqual(expectedUtf8);
      expect(utf8Decode(Uint8Array.from(expectedUtf8))).toBe(text);
      const env = encryptString(key, text, AD);
      expect(decryptString(key, env, AD)).toBe(text);
    } finally {
      Object.assign(g, saved);
    }
  });
});
