import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { getRandomBytes } from 'expo-crypto';
import { base64FromBytes, base64ToBytes, utf8Decode, utf8Encode } from '../../utils/base64';

/**
 * Encryption of cache values: XChaCha20-Poly1305 (@noble/ciphers, pure JS —
 * works identically on iOS, Android, web and in jest). Randomness comes from expo-crypto
 * (the platform CSPRNG): Hermes has no crypto.getRandomValues.
 *
 * Envelope: `enc:v1:<base64(nonce || ciphertext)>`, where ciphertext includes
 * the 16-byte Poly1305 tag. Associated data is the storage key the value is stored
 * under: ciphertext can't be silently moved under a different key.
 */

export const ENVELOPE_PREFIX = 'enc:v1:';
export const DATA_KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/** Decryption error. The message deliberately contains no data. */
export class DecryptError extends Error {
  constructor(reason: string) {
    super(`decrypt failed: ${reason}`);
    this.name = 'DecryptError';
  }
}

export function randomBytes(length: number): Uint8Array {
  const bytes = getRandomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new Error('CSPRNG unavailable');
  }
  return bytes;
}

/** New 256-bit data key (base64 for storage in SecureStore). */
export function generateDataKey(): string {
  return base64FromBytes(randomBytes(DATA_KEY_BYTES));
}

/** Parse a stored key; null = the key is corrupted. */
export function decodeDataKey(encoded: string): Uint8Array | null {
  try {
    const key = base64ToBytes(encoded);
    return key.length === DATA_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

export function isEnvelope(value: string): boolean {
  return value.startsWith(ENVELOPE_PREFIX);
}

export function encryptBytes(key: Uint8Array, plaintext: Uint8Array, associatedData: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(key, nonce, utf8Encode(associatedData)).encrypt(plaintext);
  const packed = new Uint8Array(NONCE_BYTES + sealed.length);
  packed.set(nonce, 0);
  packed.set(sealed, NONCE_BYTES);
  return ENVELOPE_PREFIX + base64FromBytes(packed);
}

export function decryptBytes(key: Uint8Array, envelope: string, associatedData: string): Uint8Array {
  if (!isEnvelope(envelope)) throw new DecryptError('not an envelope');
  let packed: Uint8Array;
  try {
    packed = base64ToBytes(envelope.slice(ENVELOPE_PREFIX.length));
  } catch {
    throw new DecryptError('malformed');
  }
  if (packed.length < NONCE_BYTES + TAG_BYTES) throw new DecryptError('truncated');
  const nonce = packed.subarray(0, NONCE_BYTES);
  const sealed = packed.subarray(NONCE_BYTES);
  try {
    return xchacha20poly1305(key, nonce, utf8Encode(associatedData)).decrypt(sealed);
  } catch {
    throw new DecryptError('authentication failed');
  }
}

export function encryptString(key: Uint8Array, plaintext: string, associatedData: string): string {
  return encryptBytes(key, utf8Encode(plaintext), associatedData);
}

export function decryptString(key: Uint8Array, envelope: string, associatedData: string): string {
  return utf8Decode(decryptBytes(key, envelope, associatedData));
}
