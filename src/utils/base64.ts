const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(input: string): number[] {
  if (typeof TextEncoder !== 'undefined') {
    return Array.from(new TextEncoder().encode(input));
  }
  // Fallback without TextEncoder
  const encoded = unescape(encodeURIComponent(input));
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) bytes.push(encoded.charCodeAt(i));
  return bytes;
}

/** UTF-8 safe base64 encode without relying on btoa or Buffer. */
export function base64Encode(input: string): string {
  const bytes = utf8Bytes(input);
  return base64FromBytes(bytes);
}

/** Base64 для бинарных данных (скачанные вложения, шифротекст). */
export function base64FromBytes(bytes: ArrayLike<number>): string {
  // Быстрый путь: нативный btoa (есть в Hermes начиная с RN 0.74 и в браузерах)
  if (typeof btoa === 'function') {
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      const chunk = Array.prototype.slice.call(bytes, i, i + 0x8000) as number[];
      parts.push(String.fromCharCode.apply(null, chunk));
    }
    return btoa(parts.join(''));
  }
  // Собираем кусками: посимвольная конкатенация на мегабайтных файлах медленная
  const chunks: string[] = [];
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    out +=
      CHARS[b0 >> 2] +
      CHARS[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] +
      (b1 === undefined ? '=' : CHARS[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)]) +
      (b2 === undefined ? '=' : CHARS[b2 & 0x3f]);
    if (out.length >= 8192) {
      chunks.push(out);
      out = '';
    }
  }
  chunks.push(out);
  return chunks.join('');
}

const DECODE_TABLE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < CHARS.length; i++) table[CHARS.charCodeAt(i)] = i;
  // base64url тоже принимаем
  table['-'.charCodeAt(0)] = 62;
  table['_'.charCodeAt(0)] = 63;
  return table;
})();

/** Base64 → байты. Некорректный ввод → исключение (без содержимого в сообщении). */
export function base64ToBytes(input: string): Uint8Array {
  if (typeof atob === 'function' && !/[-_]/.test(input)) {
    let binary: string;
    try {
      binary = atob(input);
    } catch {
      throw new Error('invalid base64');
    }
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  let end = input.length;
  while (end > 0 && input[end - 1] === '=') end--;
  if ((input.length > 0 && input.length % 4 === 1) || input.length - end > 2) {
    throw new Error('invalid base64');
  }
  const outLen = Math.floor((end * 3) / 4);
  const out = new Uint8Array(outLen);
  let buffer = 0;
  let bits = 0;
  let pos = 0;
  for (let i = 0; i < end; i++) {
    const code = input.charCodeAt(i);
    const value = code < 128 ? DECODE_TABLE[code] : -1;
    if (value < 0) throw new Error('invalid base64');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[pos++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** Строка → UTF-8 байты. */
export function utf8Encode(input: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(input);
  return Uint8Array.from(utf8Bytes(input));
}

/** UTF-8 байты → строка (без TextDecoder: в Hermes его может не быть). */
export function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
  const parts: string[] = [];
  let codes: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
    } else if (b0 >= 0xc0 && b0 < 0xe0) {
      cp = ((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f);
    } else if (b0 >= 0xe0 && b0 < 0xf0) {
      cp = ((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    } else if (b0 >= 0xf0) {
      cp =
        ((b0 & 0x07) << 18) |
        ((bytes[i++] & 0x3f) << 12) |
        ((bytes[i++] & 0x3f) << 6) |
        (bytes[i++] & 0x3f);
    } else {
      cp = 0xfffd;
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      codes.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      codes.push(cp);
    }
    if (codes.length >= 4096) {
      parts.push(String.fromCharCode(...codes));
      codes = [];
    }
  }
  parts.push(String.fromCharCode(...codes));
  return parts.join('');
}
