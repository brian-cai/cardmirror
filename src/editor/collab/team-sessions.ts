/**
 * Team sessions — the client side of the optional relay extension
 * "team sessions v1" (reference-docs/relay-team-sessions-v1.md).
 *
 * A teammate's co-editing sessions show up under Join session, and you
 * can ask to join one; someone already in it approves by sending you the
 * normal session invite card. The relay only ever stores blobs sealed
 * with the team key from the team file (pairing/team-key.ts), so it never
 * learns a session's name, a person's name or a share code (except that
 * an OPEN listing carries its share code inside the sealed blob).
 *
 * Strictly additive and quiet:
 *  - Off unless this machine has a team key AND the relay answers the
 *    discovery call (`GET /ext/team-sessions/v1`); a relay without the
 *    extension sees exactly one extra GET per relay URL per app run.
 *  - Every call rides the normal RoomsClient (custom URL + token, `/r/…`
 *    bases, entitlements), and no call ever throws into an editor flow.
 *  - 401/403/404/410 on a room drops the feature for that room, silently.
 *  - No new stream frames: the base protocol is untouched.
 *
 * Light module (no Loro): collab-relay's End path imports it.
 */

import { RoomsError, type RoomsClient } from './room-client.js';
import { appVersion } from '../install-info.js';
import { isTeamKey, openTeamBlob, sealTeamBlob, teamBlobBytes, fromBase64Url, toBase64Url } from '../pairing/team-key.js';

/** The `client` field of listings and requests. */
export const TEAM_SESSIONS_CLIENT = `cardmirror-xtgg/${appVersion}`;
/** Join-request poll while in a listed `request` room (spec: 15 s is plenty). */
export const JOIN_REQUEST_POLL_MS = 15_000;
/** A participant re-checks whether its room is listed this often. */
const LISTING_RECHECK_MS = 5 * 60_000;

export type ListingMode = 'open' | 'request';

export interface ListingPayload {
  v: 1;
  name: string;
  startedBy: string;
  mode: ListingMode;
  /** Only when mode is open. */
  shareCode?: string;
  /** Who's in it now (display names), refreshed by the host as people
   *  come and go. Optional: older clients neither send nor read it. */
  people?: string[];
  client: string;
}

export interface JoinRequestPayload {
  v: 1;
  name: string;
  /** The requester's mailbox routing code (sha256 of their key, 16 bytes). */
  recipientCode: string;
  /** The requester's sealing public key — their `cmk1.` pairing code. */
  publicKey: string;
  client: string;
}

export interface TeamSessionsSupport {
  v: 1;
  maxBlobBytes: number;
  requestTtlSeconds: number;
}

/** What a team-sessions call needs: the relay client, the base URL it
 *  talks to (the discovery cache key) and the team key. */
export interface TeamContext {
  client: RoomsClient;
  baseUrl: string;
  teamKey: string;
}

/** One decrypted entry of `GET /team-sessions`. */
export interface TeamSessionEntry {
  roomId: string;
  name: string;
  startedBy: string;
  mode: ListingMode;
  shareCode: string | null;
  participants: number;
  lastActivity: number;
  /** Who's in it, as the host last listed it ([] = not said). */
  people: string[];
}

/** One decrypted pending join request. */
export interface PendingJoinRequest {
  roomId: string;
  requestId: string;
  name: string;
  recipientCode: string;
  publicKey: string;
  createdAt: number;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// --- payloads ---------------------------------------------------------

export const LISTING_MAX_PEOPLE = 20;

export function buildListingPayload(o: {
  name: string;
  startedBy: string;
  mode: ListingMode;
  shareCode: string;
  people?: readonly string[];
}): ListingPayload {
  const people = (o.people ?? []).map((n) => n.trim().slice(0, 60)).filter(Boolean).slice(0, LISTING_MAX_PEOPLE);
  return {
    v: 1,
    name: o.name.trim().slice(0, 200) || 'Collaboration session',
    startedBy: o.startedBy.trim().slice(0, 80) || 'A teammate',
    mode: o.mode,
    // The share code IS the capability to join: only an open listing
    // carries it.
    ...(o.mode === 'open' ? { shareCode: o.shareCode } : {}),
    ...(people.length ? { people } : {}),
    client: TEAM_SESSIONS_CLIENT,
  };
}

export function parseListingPayload(raw: unknown): Omit<ListingPayload, 'client'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  const mode = r['mode'] === 'open' ? 'open' : r['mode'] === 'request' ? 'request' : null;
  if (!mode) return null;
  const shareCode = str(r['shareCode'], 4000);
  if (mode === 'open' && !/^cmshare[12]\./.test(shareCode)) return null;
  return {
    v: 1,
    name: str(r['name'], 200) || 'Collaboration session',
    startedBy: str(r['startedBy'], 80) || 'A teammate',
    mode,
    ...(mode === 'open' ? { shareCode } : {}),
    ...(Array.isArray(r['people'])
      ? { people: r['people'].map((n) => str(n, 60)).filter(Boolean).slice(0, LISTING_MAX_PEOPLE) }
      : {}),
  };
}

export function buildJoinRequestPayload(o: {
  name: string;
  recipientCode: string;
  publicKey: string;
}): JoinRequestPayload {
  return {
    v: 1,
    name: o.name.trim().slice(0, 80) || 'A teammate',
    recipientCode: o.recipientCode,
    publicKey: o.publicKey,
    client: TEAM_SESSIONS_CLIENT,
  };
}

export function parseJoinRequestPayload(raw: unknown): Omit<JoinRequestPayload, 'client'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  const publicKey = str(r['publicKey'], 2000);
  const recipientCode = str(r['recipientCode'], 200);
  if (!publicKey.startsWith('cmk1.') || !recipientCode) return null;
  return { v: 1, name: str(r['name'], 80) || 'A teammate', recipientCode, publicKey };
}

/** The mailbox routing code for a pairing code: sha256(raw key)[0..16),
 *  base64url — the same derivation as the desktop main process
 *  (pairing-crypto.ts routingId) and the web mailbox. */
export async function routingIdFor(publicCode: string): Promise<string> {
  const t = publicCode.trim();
  const raw = fromBase64Url(t.startsWith('cmk1.') ? t.slice(5) : t);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource));
  return toBase64Url(digest.subarray(0, 16));
}

// --- errors -----------------------------------------------------------

/** The statuses that drop the feature for a room, quietly: our team may
 *  not touch it (401/403), or it's gone (404/410). */
export function dropsFeatureForRoom(err: unknown): boolean {
  return err instanceof RoomsError && [401, 403, 404, 410].includes(err.status);
}

// --- discovery --------------------------------------------------------

const discovery = new Map<string, Promise<TeamSessionsSupport | null>>();

/** Does the relay at `baseUrl` support the extension? Cached per base URL
 *  for the app run (a relay change is a new key, so it's re-checked). A
 *  network failure is not cached, so the next call asks again. */
export function teamSessionsSupport(client: RoomsClient, baseUrl: string): Promise<TeamSessionsSupport | null> {
  const key = baseUrl.replace(/\/+$/, '');
  const hit = discovery.get(key);
  if (hit) return hit;
  const p = client.teamSessionsInfo().then(
    (body): TeamSessionsSupport | null => {
      if (body?.v !== 1) return null;
      const max = Number(body.maxBlobBytes);
      const ttl = Number(body.requestTtlSeconds);
      return {
        v: 1,
        maxBlobBytes: Number.isFinite(max) && max > 0 ? max : 4096,
        requestTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 86400,
      };
    },
    (err): TeamSessionsSupport | null => {
      if (err instanceof RoomsError && err.status === 0) discovery.delete(key);
      return null;
    },
  );
  discovery.set(key, p);
  return p;
}

/** Discovery with a deadline, for flows a person is waiting on (the start
 *  prompt): a slow relay just means no team-sessions UI this time. */
export async function teamSessionsSupportWithin(
  ctx: TeamContext,
  ms: number,
): Promise<TeamSessionsSupport | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const late = new Promise<null>((r) => {
    timer = setTimeout(() => r(null), ms);
  });
  try {
    return await Promise.race([teamSessionsSupport(ctx.client, ctx.baseUrl), late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- the rooms this machine listed (survives restart, for host resume) --

const LISTED_KEY = 'pmd-team-listed-rooms';

interface ListedRoom {
  mode: ListingMode;
  at: number;
}

function readListed(): Record<string, ListedRoom> {
  try {
    const v = localStorage.getItem(LISTED_KEY);
    const o = v ? (JSON.parse(v) as unknown) : null;
    return o && typeof o === 'object' ? (o as Record<string, ListedRoom>) : {};
  } catch {
    return {};
  }
}

function writeListed(map: Record<string, ListedRoom>): void {
  try {
    // A week is longer than any room lives idle; prune the rest.
    const cutoff = Date.now() - 7 * 86_400_000;
    for (const [id, r] of Object.entries(map)) if (!(r?.at > cutoff)) delete map[id];
    localStorage.setItem(LISTED_KEY, JSON.stringify(map));
  } catch {
    /* private mode / quota — a resumed host just won't re-list */
  }
}

/** How this machine listed `roomId`, or null when it didn't. */
export function listedMode(roomId: string): ListingMode | null {
  const r = readListed()[roomId];
  return r?.mode === 'open' || r?.mode === 'request' ? r.mode : null;
}

function rememberListed(roomId: string, mode: ListingMode): void {
  const map = readListed();
  map[roomId] = { mode, at: Date.now() };
  writeListed(map);
}

function forgetListed(roomId: string): void {
  const map = readListed();
  if (!(roomId in map)) return;
  delete map[roomId];
  writeListed(map);
}

// --- listing ----------------------------------------------------------

/** PUT (or replace) this room's listing. Resolves true when listed;
 *  never throws. A room the relay refuses (403/404/410) is forgotten. */
export async function listRoom(
  ctx: TeamContext,
  room: { roomId: string; name: string; startedBy: string; mode: ListingMode; shareCode: string; people?: readonly string[] },
): Promise<boolean> {
  try {
    const support = await teamSessionsSupport(ctx.client, ctx.baseUrl);
    if (!support || !isTeamKey(ctx.teamKey)) return false;
    let blob = await sealTeamBlob(ctx.teamKey, buildListingPayload(room));
    if (teamBlobBytes(blob) > support.maxBlobBytes) {
      // Only a huge name can do this: trim it rather than not list.
      blob = await sealTeamBlob(ctx.teamKey, buildListingPayload({ ...room, name: room.name.slice(0, 60) }));
      if (teamBlobBytes(blob) > support.maxBlobBytes) return false;
    }
    await ctx.client.putListing(room.roomId, blob);
    rememberListed(room.roomId, room.mode);
    return true;
  } catch (err) {
    if (dropsFeatureForRoom(err)) forgetListed(room.roomId);
    return false;
  }
}

/** Take down a listing this machine made (host End). Ending the room
 *  removes it on the relay anyway; this is the explicit half. Never
 *  throws, and never calls the relay for a room we didn't list. */
export async function unlistRoom(client: RoomsClient, roomId: string): Promise<void> {
  if (!listedMode(roomId)) return;
  try {
    await client.deleteListing(roomId);
  } catch {
    /* gone already, or offline: the room's end clears it server-side */
  }
  forgetListed(roomId);
}

// --- the join dialog --------------------------------------------------

/** Every listed session of the team that decrypts with our key, newest
 *  activity first (the relay's order). Null when the feature is off for
 *  this relay or the call failed — the dialog then shows no section. */
export async function loadTeamSessions(ctx: TeamContext): Promise<TeamSessionEntry[] | null> {
  try {
    if (!isTeamKey(ctx.teamKey) || !(await teamSessionsSupport(ctx.client, ctx.baseUrl))) return null;
    const raw = await ctx.client.listTeamSessions();
    const out: TeamSessionEntry[] = [];
    for (const s of raw) {
      // Another key (an old rotation, a different team file) → skip.
      const listing = parseListingPayload(await openTeamBlob(ctx.teamKey, s.blob));
      if (!listing) continue;
      out.push({
        roomId: s.roomId,
        name: listing.name,
        startedBy: listing.startedBy,
        mode: listing.mode,
        shareCode: listing.shareCode ?? null,
        participants: s.participants,
        lastActivity: s.lastActivity,
        people: listing.people ?? [],
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Rooms this app run already asked to join (the dialog shows them as
 *  sent instead of offering the button again). */
const requested = new Set<string>();

export function alreadyRequested(roomId: string): boolean {
  return requested.has(roomId);
}

/** POST a join request for `roomId`: our name, our mailbox routing code
 *  and sealing key, so whoever approves can send us the invite card. */
export async function requestToJoin(
  ctx: TeamContext,
  roomId: string,
  me: { name: string; publicCode: string },
): Promise<'sent' | 'gone' | 'failed'> {
  try {
    const support = await teamSessionsSupport(ctx.client, ctx.baseUrl);
    if (!support || !isTeamKey(ctx.teamKey)) return 'failed';
    const payload = buildJoinRequestPayload({
      name: me.name,
      recipientCode: await routingIdFor(me.publicCode),
      publicKey: me.publicCode,
    });
    await ctx.client.postJoinRequest(roomId, await sealTeamBlob(ctx.teamKey, payload));
    requested.add(roomId);
    return 'sent';
  } catch (err) {
    return dropsFeatureForRoom(err) ? 'gone' : 'failed';
  }
}

// --- approvals --------------------------------------------------------

/** Pending requests for a room, decrypted (undecryptable or malformed
 *  ones skipped). Throws RoomsError so the watcher can apply the drop
 *  rule. */
export async function fetchJoinRequests(ctx: TeamContext, roomId: string): Promise<PendingJoinRequest[]> {
  const raw = await ctx.client.listJoinRequests(roomId);
  const out: PendingJoinRequest[] = [];
  for (const r of raw) {
    const p = parseJoinRequestPayload(await openTeamBlob(ctx.teamKey, r.blob));
    if (!p) continue;
    out.push({
      roomId,
      requestId: r.requestId,
      name: p.name,
      recipientCode: p.recipientCode,
      publicKey: p.publicKey,
      createdAt: r.createdAt,
    });
  }
  return out;
}

/** Approve: send the requester the normal session invite card (the
 *  caller's send path — the same as inviting them by hand), then delete
 *  the request. A request whose routing code doesn't match its key is
 *  refused (the invite would go to a mailbox nobody reads). The delete
 *  is best-effort: another participant may have handled it first, and a
 *  second invite to the same person is harmless. */
export async function approveJoinRequest(
  client: RoomsClient,
  req: PendingJoinRequest,
  sendInvite: (publicKey: string, name: string) => Promise<boolean>,
): Promise<'sent' | 'mismatch' | 'failed'> {
  let routing: string;
  try {
    routing = await routingIdFor(req.publicKey);
  } catch {
    return 'mismatch';
  }
  if (routing !== req.recipientCode) return 'mismatch';
  if (!(await sendInvite(req.publicKey, req.name))) return 'failed';
  await denyJoinRequest(client, req.roomId, req.requestId);
  return 'sent';
}

/** Deny (and the tail of approve): DELETE the request. 204 on one that's
 *  already gone is fine; every error is swallowed. */
export async function denyJoinRequest(client: RoomsClient, roomId: string, requestId: string): Promise<void> {
  try {
    await client.deleteJoinRequest(roomId, requestId);
  } catch {
    /* first action won elsewhere, or offline: it expires on its own */
  }
}

// --- the per-room watcher ---------------------------------------------

export interface JoinRequestWatcherOptions {
  roomId: string;
  role: 'host' | 'participant';
  /** Resolved per tick (credentials renew; the key may arrive later). */
  context: () => TeamContext | null;
  /** The current pending set, every poll (empty clears the prompt). */
  onRequests: (requests: PendingJoinRequest[]) => void;
  /** Our own pairing code: requests from it are never shown. */
  ownCode?: () => string;
  intervalMs?: number;
  /** Test seam; default: the document is hidden. */
  isHidden?: () => boolean;
}

/** Poll a room's join requests while it's a listed `request` room. Paused
 *  while the window is hidden (and polled at once when it's shown again).
 *  Stops for good on a drop status. Returns the stop function. */
export function watchJoinRequests(opts: JoinRequestWatcherOptions): { stop: () => void; tick: () => Promise<void> } {
  let stopped = false;
  let busy = false;
  let participantListed: { mode: ListingMode | null; at: number } | null = null;
  const hidden =
    opts.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    opts.onRequests([]);
  };

  /** Is this room listed as `request`? The host knows (it listed it); a
   *  participant looks it up in the team's listings now and then. */
  const listedForRequests = async (ctx: TeamContext): Promise<boolean> => {
    if (opts.role === 'host') return listedMode(opts.roomId) === 'request';
    if (!participantListed || Date.now() - participantListed.at > LISTING_RECHECK_MS) {
      const all = await loadTeamSessions(ctx);
      if (!all) return false; // failed: ask again next tick
      participantListed = { mode: all.find((s) => s.roomId === opts.roomId)?.mode ?? null, at: Date.now() };
    }
    return participantListed.mode === 'request';
  };

  const tick = async (): Promise<void> => {
    if (stopped || busy || hidden()) return;
    busy = true;
    try {
      const ctx = opts.context();
      if (!ctx) return;
      if (!(await teamSessionsSupport(ctx.client, ctx.baseUrl))) {
        stop();
        return;
      }
      if (!(await listedForRequests(ctx))) {
        opts.onRequests([]);
        return;
      }
      const own = opts.ownCode?.() ?? '';
      const reqs = (await fetchJoinRequests(ctx, opts.roomId)).filter((r) => r.publicKey !== own);
      if (!stopped) opts.onRequests(reqs);
    } catch (err) {
      if (dropsFeatureForRoom(err)) stop();
      // Anything else (offline, 429, 5xx): try again next tick.
    } finally {
      busy = false;
    }
  };

  const onVisible = (): void => {
    if (!hidden()) void tick();
  };
  const timer: ReturnType<typeof setInterval> | null = setInterval(
    () => void tick(),
    opts.intervalMs ?? JOIN_REQUEST_POLL_MS,
  );
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  // First look soon, not 15 s in.
  setTimeout(() => void tick(), 1500);
  return { stop, tick };
}

export function __resetTeamSessionsForTests(): void {
  discovery.clear();
  requested.clear();
  try {
    localStorage.removeItem(LISTED_KEY);
  } catch {
    /* none */
  }
}
