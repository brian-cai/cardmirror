/**
 * End-to-end encryption for cross-machine card sharing.
 *
 * The relay host stores and forwards bundles but must never be able to read a
 * card. We use a libsodium-style **sealed box**: anonymous public-key
 * encryption to the recipient's key, so only the recipient's private key can
 * open it and the host (and any sender-side observer) sees only ciphertext.
 *
 *   X25519 ECDH (ephemeral sender key → recipient public key)
 *     → HKDF-SHA256(shared, salt = ephPub‖recipPub)
 *     → AES-256-GCM(plaintext)
 *
 * A machine's **pairing code** IS its X25519 public key (`cmk1.<base64url>`),
 * which is what you share out-of-band; senders encrypt to it. The on-wire
 * **routing code** the host sees is a hash of the public key, so the host
 * learns only "deliver to this opaque mailbox", never the key or the content.
 *
 * No Electron dependency (the keystore path is injected) so this is unit-
 * testable under plain Node. All crypto is `node:crypto` — no external deps.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import * as fs from 'node:fs';

const CODE_PREFIX = 'cmk1.';
const HKDF_INFO = Buffer.from('cardmirror-pairing-v1');

export interface SealedBundle {
  /** Ephemeral sender public key (base64url raw X25519). */
  epk: string;
  /** AES-GCM nonce (base64url). */
  iv: string;
  /** Ciphertext (base64url). */
  ct: string;
  /** AES-GCM auth tag (base64url). */
  tag: string;
}

export interface PairingKeystore {
  /** This machine's shareable code = its public key (`cmk1.…`). */
  ownPublicCode(): string;
  /** The opaque routing code the host sees for this machine. */
  ownRoutingId(): string;
  /** Throw away the keypair and mint a fresh one (invalidates old shares). */
  regenerate(): string;
  /** Encrypt an object to a recipient's public code. Anonymous (sealed box). */
  seal(obj: unknown, recipientPublicCode: string): SealedBundle;
  /** Decrypt a bundle addressed to us. Throws on tamper / wrong key. */
  open(bundle: SealedBundle): unknown;
  /** `X-Mailbox-Proof` value proving this machine holds its key, for one
   *  call to a relay advertising `relayKey` (mailbox proof v1; see
   *  mailboxProofMac). */
  mailboxProof(relayKey: string, method: string, ts: number): string;
  /** The v2 header (mailboxProofMacV2): also binds the relay's origin and,
   *  for a PUT, the exact body bytes; for a DELETE, `target` (what it
   *  deletes — mailboxProofBodyHash). */
  mailboxProofV2(relayKey: string, origin: string, method: string, ts: number, body?: string | Uint8Array, target?: string): string;
}

const PROOF_INFO = Buffer.from('xtgg-mailbox-proof-v1');
const PROOF_INFO_V2 = Buffer.from('xtgg-mailbox-proof-v2');

/** Mailbox proof v1 (xtgg relay docs/mailbox-proof-v1.md): HMAC-SHA256 over
 *  `v1|METHOD|routing|ts`, keyed by HKDF-SHA256 of X25519(own key, relay key)
 *  with salt ownPub‖relayPub. Proves the caller holds the private key behind
 *  its routing code without revealing it. */
export function mailboxProofMac(shared: Buffer, ownPubRaw: Buffer, relayPubRaw: Buffer, method: string, routing: string, ts: number): Buffer {
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ownPubRaw, relayPubRaw]), PROOF_INFO, 32));
  return createHmac('sha256', key).update(`v1|${method}|${routing}|${ts}`).digest();
}

/** Mailbox proof v2 (xtgg relay docs/mailbox-proof-v2.md): like v1, but the
 *  MAC also covers the relay's origin (so a proof made for one relay can't
 *  be replayed at another sharing its key) and the request body's hash
 *  (so a PUT's proof can't carry a different body):
 *  `v2|ORIGIN|METHOD|rcp|ts|BODYHASH`, keyed by HKDF-SHA256 of the same
 *  shared secret with info "xtgg-mailbox-proof-v2". */
export function mailboxProofMacV2(
  shared: Buffer,
  ownPubRaw: Buffer,
  relayPubRaw: Buffer,
  origin: string,
  method: string,
  routing: string,
  ts: number,
  bodyHash: string,
): Buffer {
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ownPubRaw, relayPubRaw]), PROOF_INFO_V2, 32));
  return createHmac('sha256', key).update(`v2|${origin}|${method}|${routing}|${ts}|${bodyHash}`).digest();
}

/** BODYHASH for v2: base64url(sha256(body bytes)) for a PUT; for a DELETE,
 *  `target` as is, not hashed (the message id as in the path of
 *  `DELETE /messages/{id}`, or C of `DELETE /team-directory/me?code=C`, both
 *  URL-decoded), so the proof deletes only what it names; '' otherwise. */
export function mailboxProofBodyHash(method: string, body?: string | Uint8Array, target?: string): string {
  if (method === 'DELETE') return target ?? '';
  if (method !== 'PUT') return '';
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body ?? new Uint8Array(0));
  return createHash('sha256').update(bytes).digest('base64url');
}

/** ORIGIN for v2: lowercase `scheme://host[:port]` of a relay URL, default
 *  port left out ('' when it isn't an http(s) URL). Always from the URL
 *  this client is configured with — never from anything the relay says. */
export function mailboxProofOrigin(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return '';
  }
}

function rawPub(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x: string };
  return Buffer.from(jwk.x, 'base64url');
}

function pubObjectFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') },
    format: 'jwk',
  });
}

/** Decode the raw 32-byte public key from a `cmk1.…` code (lenient about the
 *  prefix so a pasted bare key still works). */
function rawFromPublicCode(code: string): Buffer {
  const trimmed = code.trim();
  const b64 = trimmed.startsWith(CODE_PREFIX) ? trimmed.slice(CODE_PREFIX.length) : trimmed;
  return Buffer.from(b64, 'base64url');
}

/** The host-visible routing code for a public code: a 16-byte hash of the key.
 *  Deterministic, so sender (hashing the recipient's code) and recipient
 *  (hashing its own) agree, while the host can't recover the key. */
export function routingId(publicCode: string): string {
  const raw = rawFromPublicCode(publicCode);
  return createHash('sha256').update(raw).digest().subarray(0, 16).toString('base64url');
}

function deriveKey(shared: Buffer, ephPubRaw: Buffer, recipPubRaw: Buffer): Buffer {
  const salt = Buffer.concat([ephPubRaw, recipPubRaw]);
  return Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, 32));
}

/** Create a keystore backed by a JSON file (the X25519 keypair as JWK). The
 *  private key never leaves this process / that file. */
export function createPairingKeystore(keysFilePath: string): PairingKeystore {
  let priv: KeyObject | null = null;
  let pub: KeyObject | null = null;
  let pubRawCache: Buffer | null = null;

  const persist = (): void => {
    const jwk = priv!.export({ format: 'jwk' }) as { d: string; x: string };
    const tmp = `${keysFilePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, d: jwk.d, x: jwk.x }), { mode: 0o600 });
    fs.renameSync(tmp, keysFilePath);
  };

  const generate = (): void => {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    priv = privateKey;
    pub = publicKey;
    pubRawCache = rawPub(publicKey);
    persist();
  };

  const load = (): boolean => {
    try {
      const data = JSON.parse(fs.readFileSync(keysFilePath, 'utf8'));
      if (!data || typeof data.d !== 'string' || typeof data.x !== 'string') return false;
      priv = createPrivateKey({
        key: { kty: 'OKP', crv: 'X25519', d: data.d, x: data.x },
        format: 'jwk',
      });
      pub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: data.x }, format: 'jwk' });
      pubRawCache = Buffer.from(data.x, 'base64url');
      return true;
    } catch {
      return false;
    }
  };

  const ensure = (): void => {
    if (priv && pub && pubRawCache) return;
    if (!load()) generate();
  };

  return {
    ownPublicCode(): string {
      ensure();
      return CODE_PREFIX + pubRawCache!.toString('base64url');
    },
    ownRoutingId(): string {
      return routingId(this.ownPublicCode());
    },
    regenerate(): string {
      generate();
      return CODE_PREFIX + pubRawCache!.toString('base64url');
    },
    seal(obj: unknown, recipientPublicCode: string): SealedBundle {
      const recipRaw = rawFromPublicCode(recipientPublicCode);
      const recipPub = pubObjectFromRaw(recipRaw);
      const eph = generateKeyPairSync('x25519');
      const ephRaw = rawPub(eph.publicKey);
      const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipPub });
      const key = deriveKey(shared, ephRaw, recipRaw);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const pt = Buffer.from(JSON.stringify(obj), 'utf8');
      const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
      return {
        epk: ephRaw.toString('base64url'),
        iv: iv.toString('base64url'),
        ct: ct.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
      };
    },
    open(bundle: SealedBundle): unknown {
      ensure();
      const ephRaw = Buffer.from(bundle.epk, 'base64url');
      const ephPub = pubObjectFromRaw(ephRaw);
      const shared = diffieHellman({ privateKey: priv!, publicKey: ephPub });
      const key = deriveKey(shared, ephRaw, pubRawCache!);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bundle.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(bundle.tag, 'base64url'));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(bundle.ct, 'base64url')),
        decipher.final(),
      ]);
      return JSON.parse(pt.toString('utf8'));
    },
    mailboxProof(relayKey: string, method: string, ts: number): string {
      ensure();
      const relayRaw = Buffer.from(relayKey, 'base64url');
      const shared = diffieHellman({ privateKey: priv!, publicKey: pubObjectFromRaw(relayRaw) });
      const routing = routingId(CODE_PREFIX + pubRawCache!.toString('base64url'));
      const mac = mailboxProofMac(shared, pubRawCache!, relayRaw, method, routing, ts);
      return `v1.${pubRawCache!.toString('base64url')}.${ts}.${mac.toString('base64url')}`;
    },
    mailboxProofV2(relayKey: string, origin: string, method: string, ts: number, body?: string | Uint8Array, target?: string): string {
      ensure();
      const relayRaw = Buffer.from(relayKey, 'base64url');
      const shared = diffieHellman({ privateKey: priv!, publicKey: pubObjectFromRaw(relayRaw) });
      const routing = routingId(CODE_PREFIX + pubRawCache!.toString('base64url'));
      const mac = mailboxProofMacV2(shared, pubRawCache!, relayRaw, origin, method, routing, ts, mailboxProofBodyHash(method, body, target));
      return `v2.${pubRawCache!.toString('base64url')}.${ts}.${mac.toString('base64url')}`;
    },
  };
}
