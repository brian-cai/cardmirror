/**
 * Constants shared by every client that talks to the relay — the main
 * process (card sharing, `pairing-ipc.ts`) and the renderer (co-editing,
 * `collab/room-client.ts`) alike.
 *
 * Deliberately dependency-free: this module is imported into BOTH the
 * Electron main bundle and the renderer bundle, so it must not pull in
 * `getHost()`, the DOM, or anything Electron.
 */

/**
 * Header naming the CardMirror build behind a relay request.
 *
 * Sent on every relay call so the server can tell versions apart. It is
 * advisory only — relays that don't know the header ignore it, which is
 * why the client can start sending it well before any relay reads it.
 * Custom request headers are preflighted by browsers for the web
 * edition, but every relay implementation allows them (`allow_headers`
 * is the wildcard in all three), and the existing `Authorization`
 * header already proves that path works.
 *
 * NOTE for a future minimum-version gate: absence of this header means
 * the client predates it, NOT that the request is anonymous — every
 * build shipped before this header existed will send nothing at all.
 */
export const RELAY_CLIENT_VERSION_HEADER = 'X-CardMirror-Version';

/**
 * Header carrying this machine's routing code (the public sha256 hash of
 * its pairing key) on relay requests authenticated with an ENTITLEMENT.
 *
 * Entitlement JWTs are bearer tokens minted per machine (`/connect`
 * binds them to a routing code in their `rc` claim), but nothing at
 * request time proved the presenter WAS that machine — a copied token
 * file worked from anywhere. When the relay's machine-binding toggle is
 * on, gated requests must carry this header matching the token's claim.
 * Sent only when the effective bearer is an entitlement: shared-token
 * and self-hosted requests have no `rc` to match and omit it.
 */
export const RELAY_CLIENT_ROUTING_HEADER = 'X-CardMirror-Routing';

/**
 * First app version that seeds co-editing rooms with movable-list
 * children (identity-preserving moves; strict exactly-once under
 * concurrent same-card moves — fuzz-proven). The binding's per-room
 * inheritance keeps every room homogeneous, so this constant does two
 * jobs: builds >= it seed NEW rooms movable, and invites to movable
 * rooms carry it as their compatibility floor so older builds decline
 * cleanly instead of joining a room they cannot read.
 */
export const MOVABLE_ROOMS_MIN_VERSION = '1.0.0';

/**
 * Prerelease-aware version compare for CardMirror's version shapes
 * (`X.Y.Z`, `X.Y.Z-alpha.N`, `-beta.N`, `-rc.N`). Returns <0, 0, >0.
 * A release outranks its own prereleases; unknown prerelease labels
 * rank with beta; unparseable strings rank lowest (a garbled version
 * must never unlock version-gated behavior).
 */
export function compareAppVersions(a: string, b: string): number {
  const key = (v: string): number[] => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    if (!m) return [-1, 0, 0, 0, 0, 0];
    const core = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!m[4]) return [...core, 1, 0, 0];
    const parts = m[4].split('.');
    const rank = { alpha: 0, beta: 1, rc: 2 }[parts[0]!.toLowerCase() as 'alpha'] ?? 1;
    const num = parts[1] && /^\d+$/.test(parts[1]) ? Number(parts[1]) : 0;
    return [...core, 0, rank, num];
  };
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < 6; i++) {
    if (ka[i]! !== kb[i]!) return ka[i]! - kb[i]!;
  }
  return 0;
}

// --- relay info v1 (reference-docs/relay-info-v1.md) -------------------

/** This build's client id for the optional relay extensions. The only
 *  built-in identity: everything about the relay itself (operator,
 *  links, plan) comes from the relay's own info document. */
export const RELAY_CLIENT_ID = 'cardmirror-xtgg';

/** `<client id>/<version>` — which build is calling (relay info v1). */
export const RELAY_EXT_CLIENT_HEADER = 'X-Relay-Client';

/** A name for this install the user agreed to show the people who manage
 *  the relay credential (relay info v1). Percent-encoded UTF-8. */
export const RELAY_EXT_INSTALL_NAME_HEADER = 'X-Relay-Install-Name';

/** Both headers are capped at 64 bytes by the spec (the install name
 *  measured after decoding). */
export const RELAY_EXT_HEADER_MAX_BYTES = 64;

/** `cardmirror-xtgg/<version>`, restricted to the spec's alphabet
 *  (`[A-Za-z0-9._-]` and one `/`) and 64 bytes. A version that can't be
 *  expressed sends just the id. */
export function relayClientHeaderValue(version: string, clientId: string = RELAY_CLIENT_ID): string {
  const v = version.replace(/[^A-Za-z0-9._-]/g, '');
  const value = v ? `${clientId}/${v}` : clientId;
  return value.slice(0, RELAY_EXT_HEADER_MAX_BYTES);
}

/** The install-name header value: trimmed, control characters and runs
 *  of whitespace folded, cut to 64 UTF-8 bytes on a character boundary,
 *  then percent-encoded (every byte outside `[A-Za-z0-9._~-]`, so `'`
 *  becomes `%27` as in the spec's example). '' = send nothing. */
export function encodeInstallName(name: string): string {
  const clean = name
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const enc = new TextEncoder();
  let out = '';
  let bytes = 0;
  for (const ch of clean) {
    const n = enc.encode(ch).length;
    if (bytes + n > RELAY_EXT_HEADER_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return encodeURIComponent(out.trimEnd()).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The relay-info request headers for one request: always the client
 *  header, plus the install name when there is one to send. Callers send
 *  these only to a relay the user configured (never the built-in one). */
export function relayExtHeaders(o: { version: string; installName?: string }): Record<string, string> {
  const name = encodeInstallName(o.installName ?? '');
  return {
    [RELAY_EXT_CLIENT_HEADER]: relayClientHeaderValue(o.version),
    ...(name ? { [RELAY_EXT_INSTALL_NAME_HEADER]: name } : {}),
  };
}

// --- saved relays / per-relay state ----------------------------------

/** A short, non-reversible fingerprint of a relay token (FNV-1a, 32
 *  bits): enough to tell two credentials on one relay apart, useless as
 *  a credential. */
export function tokenFingerprint(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** One custom relay + credential: the URL (no trailing slash) and the
 *  token's fingerprint. Keys saved relays and team directory state. */
export function relayMatchKey(url: string, token: string): string {
  return `${url.trim().replace(/\/+$/, '')}#${tokenFingerprint(token.trim())}`;
}
