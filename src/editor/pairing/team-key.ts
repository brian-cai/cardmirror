/**
 * Team key — the shared secret behind team sessions (relay extension
 * "team sessions v1", reference-docs/relay-team-sessions-v1.md).
 *
 * A random 256-bit key that lives in the team file (.cmteam) and nowhere
 * on the relay. Everything a team session listing or join request says
 * (session name, who started it, the requester's name and mailbox) is
 * sealed with it, so the relay stores only opaque blobs and another team
 * on the same relay can't read them.
 *
 * Blob format, exactly as the spec says: AES-256-GCM, 96-bit random
 * nonce, `base64url(nonce || ciphertext || tag)` — the same sealed layout
 * as the room blobs (collab-crypto.ts), just base64url-wrapped for JSON.
 *
 * Pure module (WebCrypto only, no settings / DOM), unit-tested.
 */
import { bytesToBase64, base64ToBytes } from '../../ooxml/base64.js';

export const TEAM_KEY_BYTES = 32;

export function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(b64);
}

/** A fresh random team key, base64url (43 characters). */
export function generateTeamKey(): string {
  const raw = new Uint8Array(TEAM_KEY_BYTES);
  crypto.getRandomValues(raw);
  return toBase64Url(raw);
}

/** Is `v` a well-formed team key (base64url of exactly 32 bytes)? */
export function isTeamKey(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== 43) return false;
  try {
    return fromBase64Url(v).byteLength === TEAM_KEY_BYTES;
  } catch {
    return false;
  }
}

/** Imported keys, by key string (an import is not free and a poll seals
 *  and opens a blob every 15 s). */
const imported = new Map<string, Promise<CryptoKey>>();

function cryptoKey(teamKey: string): Promise<CryptoKey> {
  let k = imported.get(teamKey);
  if (!k) {
    if (!isTeamKey(teamKey)) return Promise.reject(new Error('not a team key'));
    k = crypto.subtle.importKey('raw', fromBase64Url(teamKey) as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    imported.set(teamKey, k);
  }
  return k;
}

/** Seal a JSON value with the team key → base64url(nonce || ct || tag). */
export async function sealTeamBlob(teamKey: string, value: unknown): Promise<string> {
  const key = await cryptoKey(teamKey);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plain as BufferSource),
  );
  const out = new Uint8Array(nonce.byteLength + ct.byteLength);
  out.set(nonce, 0);
  out.set(ct, nonce.byteLength);
  return toBase64Url(out);
}

/** Open a team blob. Null on anything wrong — another key, a tampered or
 *  truncated blob, not JSON — so callers simply skip that entry. */
export async function openTeamBlob(teamKey: string, blob: string): Promise<unknown> {
  try {
    const key = await cryptoKey(teamKey);
    const sealed = fromBase64Url(blob);
    if (sealed.byteLength < 12 + 16) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.subarray(0, 12) as BufferSource },
      key,
      sealed.subarray(12) as BufferSource,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as unknown;
  } catch {
    return null;
  }
}

/** Decoded size of a blob, for the relay's `maxBlobBytes` limit. */
export function teamBlobBytes(blob: string): number {
  return Math.floor((blob.length * 3) / 4);
}

export interface TeamKeyMerge {
  /** The key to keep on this machine ('' = none). */
  key: string;
  /** This machine had no key and took the file's. */
  adopted: boolean;
  /** Both had a key and they differ: the local one was kept. */
  conflict: boolean;
}

/** The team key merge rule: an existing local key is never silently
 *  replaced. No local key → take the file's; both and different → keep
 *  the local one and report the conflict (the caller says so, quietly). */
export function mergeTeamKey(local: string, incoming: string | undefined | null): TeamKeyMerge {
  const mine = isTeamKey(local) ? local : '';
  const theirs = isTeamKey(incoming) ? incoming : '';
  if (!mine) return { key: theirs, adopted: !!theirs, conflict: false };
  return { key: mine, adopted: false, conflict: !!theirs && theirs !== mine };
}
