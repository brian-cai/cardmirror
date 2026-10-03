/**
 * Base64 helpers for embedding image bytes in schema attrs (and, via
 * collab-crypto, for collab snapshots and frames).
 *
 * Native `Uint8Array.prototype.toBase64` / `Uint8Array.fromBase64`
 * (Chromium 144+, Node 25+) where present: every image in a Word file is
 * encoded on import and decoded on export, and the JS path below builds a
 * binary string first (about 27ms per MB on encode). The fallback converts
 * in chunks so large images don't blow the spread-args stack limit.
 */

const CHUNK = 32_768;

type NativeB64 = { fromBase64?: (s: string) => Uint8Array };
const nativeU8 = Uint8Array as unknown as NativeB64;
const hasNativeDecode = typeof nativeU8.fromBase64 === 'function';
const hasNativeEncode =
  typeof (Uint8Array.prototype as unknown as { toBase64?: unknown }).toBase64 === 'function';

export function bytesToBase64(bytes: Uint8Array): string {
  if (hasNativeEncode) return (bytes as unknown as { toBase64: () => string }).toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  if (hasNativeDecode) return nativeU8.fromBase64!(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
