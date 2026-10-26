/**
 * Rooms-relay endpoint resolution, factored out of collab-ui so LIGHT
 * consumers (the invite seed prefetcher, fired from the always-loaded
 * Receive pill) can build a RoomsClient without pulling the Loro wasm
 * chunk. Resolution order: settings → dev env → baked desktop default
 * (same base + shared token card sharing uses).
 */

import { settings } from '../settings.js';
import { getElectronHost } from '../host/index.js';
import { collabDevRelay } from './collab-gate.js';
import { webEntitlementToken, webRoutingCodeSync } from './web-account.js';
import { RoomsClient, RoomsError } from './room-client.js';
import { WEB_DEFAULT_RELAY_URL } from './relay-endpoint.js';
import { unlistRoom } from './team-sessions.js';
import { customRelayExtHeaders } from './relay-info.js';
import { tokenFromAnotherHost } from './relay-profiles.js';

/** Baked relay endpoint from the desktop main process — resolved once,
 *  used as the LAST fallback so packaged builds work with zero setup.
 *  '' fields mean web edition / old preload / nothing baked.
 *  `routingCode` is non-'' only when the baked token is an entitlement
 *  (machine binding — see relay-protocol.ts). */
let bakedRelay: { url: string; token: string; routingCode: string; usable?: boolean } | null = null;
let bakedRefreshWired = false;

export async function ensureBakedRelay(): Promise<void> {
  if (bakedRelay) return;
  try {
    const got = await getElectronHost()?.collabRelayDefaults();
    bakedRelay = { url: got?.url ?? '', token: got?.token ?? '', routingCode: got?.routingCode ?? '', usable: got?.usable };
  } catch {
    bakedRelay = { url: '', token: '', routingCode: '' };
  }
  // Entitlement renewed / relinked in main → re-pull url/token/routing
  // so LIVE sessions serve the fresh credential on their next request
  // (field case 2026-08-29: the 72h entitlement expired mid-session
  // and a stale snapshot 401'd every room call until app restart —
  // renewal, and even unlink+relink, couldn't reach it).
  if (!bakedRefreshWired) {
    bakedRefreshWired = true;
    getElectronHost()?.onPairingEntitlementChanged?.(() => void refreshBakedRelay());
  }
}

/** Re-fetch the baked defaults (fresh entitlement after a renewal
 *  broadcast). Keeps the previous values on failure — a transient IPC
 *  hiccup must not blank a working credential. */
export async function refreshBakedRelay(): Promise<void> {
  try {
    const got = await getElectronHost()?.collabRelayDefaults();
    if (got) {
      bakedRelay = { url: got.url ?? '', token: got.token ?? '', routingCode: got.routingCode ?? '', usable: got.usable };
    }
  } catch {
    /* keep previous */
  }
}

// Endpoint isolated in relay-endpoint.ts so Lite builds compile the
// hostname out (desktop still gets its baked URL from the main process
// alongside the shared token, which must never appear here).

/** The resolved relay base URL ('' when nothing is configured) —
 *  shared by the rooms client and the web account-connect flow. */
export function relayBaseUrl(): string {
  const dev = collabDevRelay();
  const webDefault = getElectronHost() ? '' : WEB_DEFAULT_RELAY_URL;
  return (
    settings.get('pairingRelayUrl').trim() ||
    dev?.url ||
    bakedRelay?.url ||
    webDefault
  ).replace(/\/+$/, '');
}

/** A rooms client authenticating with a room GUEST PASS instead of a
 *  token/entitlement — the account-less joiner's credential (Phase 3).
 *  Scope matches the server's: room-data endpoints only, so joins and
 *  live sync work while create/delete stay closed. Null when no relay
 *  URL resolves. */
export function relayClientWithGuestPass(pass: string): RoomsClient | null {
  const url = relayBaseUrl();
  if (!url || !pass) return null;
  return new RoomsClient({
    baseUrl: () => url,
    token: () => pass,
    routingCode: () => '',
    guestAuth: true,
    extHeaders: () => customRelayExtHeaders(),
  });
}

/** Resolve the CURRENT credential + its paired routing code. Called
 *  per request (see relayClient) — never snapshot the result into a
 *  long-lived closure: entitlements expire after ~72h and renew in the
 *  background, and a frozen snapshot 401'd every room call of a
 *  long-running session until app restart (field case 2026-08-29).
 *
 *  A linked account's entitlement outranks the dev/prototype token:
 *  it's the real credential class, and it carries the wk1 routing code
 *  the relay's machine binding expects. Settings-field overrides
 *  (self-host) still win over everything. The routing code is bound to
 *  the ENTITLEMENT that minted it — a settings/dev token override is
 *  never an entitlement, so the header must not ride along there. */
function resolveCredential(): { token: string; routingCode: string } {
  const settingsToken = settings.get('pairingRelayToken').trim();
  if (settingsToken) return { token: settingsToken, routingCode: '' };
  // A relay typed in Settings with no token gets no credential — never the
  // built-in relay's shared token or an account entitlement handed to
  // whatever host was typed — unless it IS the host the main process
  // issued that credential for.
  return sharedCredentialFor(settings.get('pairingRelayUrl'));
}

/** The built-in/linked credential, for `typedUrl` (the relay URL in
 *  Settings, '' for none). Desktop: none for a typed host other than the
 *  one main issued it for. */
function sharedCredentialFor(typedUrl: string): { token: string; routingCode: string } {
  const typed = typedUrl.trim();
  if (typed && getElectronHost() && (!bakedRelay?.url || hostOf(typed) !== hostOf(bakedRelay.url))) {
    return { token: '', routingCode: '' };
  }
  return resolveBuiltinCredential();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/** The credential when no token is set in Settings: a linked account, a
 *  dev relay, or the built-in one. Renews in the background (see above). */
function resolveBuiltinCredential(): { token: string; routingCode: string } {
  const dev = collabDevRelay();
  const webToken = webEntitlementToken();
  const token = webToken || dev?.token || bakedRelay?.token || '';
  const routingCode = webToken ? webRoutingCodeSync() : dev?.token ? '' : (bakedRelay?.routingCode ?? '');
  return { token, routingCode };
}

/** Can this computer reach a relay with a credential? A relay set in
 *  Settings, a linked account, a dev relay, or what the desktop main
 *  process reports for its built-in one. Not known yet (the baked
 *  defaults not loaded, or an older main that doesn't say) counts as
 *  yes: the send and session paths report a missing relay themselves. */
export function relayUsable(): boolean {
  if (!getElectronHost()) return true;
  if (settings.get('pairingRelayUrl').trim() || webEntitlementToken() || collabDevRelay()) return true;
  return bakedRelay?.usable !== false;
}

export function relayClient(): RoomsClient | null {
  const url = relayBaseUrl();
  if (!url || !resolveCredential().token) return null;
  // Mid-edit: the old relay's token with the new relay's URL. No client
  // until the token is changed too (or this pair connects and is saved).
  if (tokenFromAnotherHost(settings.get('pairingRelayUrl'), settings.get('pairingRelayToken'))) return null;
  // PINNED to the relay it was made for. A client lives as long as the
  // work it serves (a running session's stream, a team-list refresh,
  // a team-sessions listing), and that work's keys and room belong to
  // this relay: editing Settings mid-session must not send the
  // session's next call to another relay with another token (it 404s
  // there and the session tears itself down), nor this team's sealed
  // listings to another team's relay. So a relay set in Settings is
  // fixed, URL and token, for the client's life, and every client keeps
  // its URL. The built-in or linked-account credential stays LIVE — the
  // entitlement swap seam
  // the interface documents: it expires after ~72h and renews in the
  // background, and a frozen snapshot 401'd a long session (field case
  // 2026-08-29). New work (the next client) picks up new settings.
  const pinnedToken = settings.get('pairingRelayToken').trim();
  const custom = Boolean(settings.get('pairingRelayUrl').trim()) || Boolean(pinnedToken);
  const typedUrl = settings.get('pairingRelayUrl');
  const credentials = pinnedToken
    ? () => ({ token: pinnedToken, routingCode: '' })
    : () => sharedCredentialFor(typedUrl);
  return new RoomsClient({
    baseUrl: () => url,
    token: () => credentials().token,
    routingCode: () => credentials().routingCode,
    // ONE resolution per request (2026-09-01 review, T13).
    credentials,
    // Relay info v1: name this build (and, if allowed, this install) to
    // a relay the user configured; {} on the built-in relay (kept so when
    // a custom relay is set later).
    extHeaders: custom ? () => customRelayExtHeaders() : () => ({}),
    // Mailbox proof (v2, else v1): signed in main for this pinned relay and
    // token; a PUT's body goes along so v2 can sign its hash.
    mailboxProof: (method, code, body) =>
      getElectronHost()?.mailboxProof?.({ baseUrl: url, token: credentials().token, method, code, body }) ?? Promise.resolve({}),
  });
}

/** Tombstone a room on the relay — the home-screen Sessions list's host-side
 *  "End Session" (no live session object exists there, so this speaks to the
 *  relay directly). A room that is already ended (410) or expired/GC'd (404)
 *  counts as success: the goal — nobody can rejoin — already holds. Throws on
 *  anything else (offline, auth) so the caller can KEEP the record and let
 *  the host retry; deleting it without the tombstone would strand a live room
 *  that invited participants can silently rejoin. */
export async function endRoomOnRelay(roomId: string): Promise<void> {
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) throw new Error('no relay configured');
  // Team sessions: take down our listing first (the room's end removes it
  // on the relay too; after the end this DELETE would only 410). No-op —
  // no request — for a room this machine never listed.
  await unlistRoom(client, roomId);
  try {
    await client.deleteRoom(roomId);
  } catch (err) {
    if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) return;
    throw err;
  }
}
