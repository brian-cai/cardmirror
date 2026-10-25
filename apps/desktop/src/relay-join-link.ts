/**
 * One-click relay setup links: `xtgg-relay://join?url=<relay>&token=<token>`.
 *
 * A coach sends teammates an https page (extinction.gg/relay/join#…) that
 * hands the OS this custom-scheme URL; the OS launches CardMirror with it
 * (macOS `open-url`, Windows / Linux argv or `second-instance`). Main parses
 * it here and forwards the result to a renderer, which asks the user before
 * writing the Collaboration settings — nothing is ever applied silently.
 *
 * Pure (no Electron imports) so the validation is unit-testable. Strict on
 * purpose: the link arrives from any web page, so anything that isn't
 * exactly the documented shape is rejected rather than repaired.
 */

export const RELAY_JOIN_SCHEME = 'xtgg-relay';

/** Upper bound on the whole link, the relay URL, and the token. Real
 *  links are a few hundred bytes; these only stop a pathological input
 *  from reaching the dialog. */
const MAX_LINK_LENGTH = 4096;
const MAX_RELAY_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 512;

export interface RelayJoinLink {
  /** https relay base URL, origin + path, trailing slashes trimmed. */
  relayUrl: string;
  token: string;
}

export type RelayJoinParse =
  | { ok: true; link: RelayJoinLink }
  | { ok: false; reason: string };

/** True when an argv entry is one of our scheme links (and so must never
 *  be treated as a file path). */
export function isRelayJoinArg(arg: unknown): boolean {
  return typeof arg === 'string' && arg.toLowerCase().startsWith(`${RELAY_JOIN_SCHEME}:`);
}

/** The first scheme link in an argv list (Windows / Linux deliver the
 *  URL as a plain command-line argument), or null. */
export function pickRelayJoinFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) if (typeof a === 'string' && isRelayJoinArg(a)) return a;
  return null;
}

/** Exactly one value for `name`, or null when it's missing or repeated. */
function singleParam(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length === 1 ? (all[0] ?? null) : null;
}

export function parseRelayJoinLink(raw: string): RelayJoinParse {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'empty link' };
  if (raw.length > MAX_LINK_LENGTH) return { ok: false, reason: 'link too long' };
  let link: URL;
  try {
    link = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparseable link' };
  }
  if (link.protocol !== `${RELAY_JOIN_SCHEME}:`) return { ok: false, reason: 'wrong scheme' };
  if (link.hostname !== 'join') return { ok: false, reason: 'host is not "join"' };
  if (link.username || link.password || link.port) {
    return { ok: false, reason: 'unexpected credentials or port' };
  }
  if (link.pathname !== '' && link.pathname !== '/') return { ok: false, reason: 'unexpected path' };

  const url = singleParam(link.searchParams, 'url');
  const token = singleParam(link.searchParams, 'token');
  if (url === null) return { ok: false, reason: 'missing or repeated url' };
  if (token === null) return { ok: false, reason: 'missing or repeated token' };

  if (url.length === 0 || url.length > MAX_RELAY_URL_LENGTH) {
    return { ok: false, reason: 'relay url empty or too long' };
  }
  let relay: URL;
  try {
    relay = new URL(url);
  } catch {
    return { ok: false, reason: 'relay url unparseable' };
  }
  // https only: the token rides every request as a bearer credential.
  if (relay.protocol !== 'https:') return { ok: false, reason: 'relay url is not https' };
  if (!relay.hostname) return { ok: false, reason: 'relay url has no host' };
  if (relay.username || relay.password) return { ok: false, reason: 'relay url has credentials' };
  // A base URL: the clients append /messages, /rooms, … to it, so a
  // query or fragment would corrupt every request.
  if (relay.search || relay.hash) return { ok: false, reason: 'relay url has a query or fragment' };

  // Printable ASCII, no whitespace — what a bearer token can carry.
  if (!/^[\x21-\x7e]+$/.test(token) || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'token empty, too long, or has whitespace/control characters' };
  }

  const relayUrl = (relay.origin + relay.pathname).replace(/\/+$/, '');
  return { ok: true, link: { relayUrl, token } };
}
