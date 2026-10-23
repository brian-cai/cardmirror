// @vitest-environment jsdom
/**
 * Team sessions (relay extension v1): team-key crypto, the key merge rule,
 * listing / join-request payload shapes, discovery gating, the approve
 * flow, and the quiet error handling — against a fake relay (fetchImpl).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import {
  approveJoinRequest,
  buildJoinRequestPayload,
  buildListingPayload,
  denyJoinRequest,
  fetchJoinRequests,
  listRoom,
  listedMode,
  loadTeamSessions,
  requestToJoin,
  routingIdFor,
  teamSessionsSupport,
  unlistRoom,
  watchJoinRequests,
  TEAM_SESSIONS_CLIENT,
  __resetTeamSessionsForTests,
  type PendingJoinRequest,
  type TeamContext,
} from '../../src/editor/collab/team-sessions.js';
import {
  generateTeamKey,
  isTeamKey,
  mergeTeamKey,
  openTeamBlob,
  sealTeamBlob,
  fromBase64Url,
} from '../../src/editor/pairing/team-key.js';
import {
  addTeamKeyToTeamFileJson,
  buildTeamFile,
  parseTeamFile,
  serializeTeamFile,
} from '../../src/editor/pairing/team-file.js';
import { pickSessionToJoin, TEAM_REQUEST_SENT_MESSAGE } from '../../src/editor/collab/rejoin-picker.js';

// A pairing code is `cmk1.` + base64url of a 32-byte X25519 public key.
const ALEX = 'cmk1.' + Buffer.alloc(32, 7).toString('base64url');
const desktopRoutingId = (code: string): string =>
  createHash('sha256').update(Buffer.from(code.slice(5), 'base64url')).digest().subarray(0, 16).toString('base64url');

// ── A fake relay ──────────────────────────────────────────────────────

interface Call {
  method: string;
  path: string;
  body: unknown;
}

function fakeRelay(opts: { supported?: boolean; status?: Record<string, number> } = {}) {
  const calls: Call[] = [];
  const listings = new Map<string, string>();
  const requests = new Map<string, { requestId: string; blob: string; createdAt: number }[]>();
  let nextId = 1;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/relay/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, path, body });
    const json = (status: number, b?: unknown) =>
      new Response(b === undefined ? null : JSON.stringify(b), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const forced = opts.status?.[`${method} ${path}`];
    if (forced) return json(forced, { detail: 'forced' });
    if (path === '/ext/team-sessions/v1') {
      return opts.supported === false
        ? json(404, { detail: 'Not Found' })
        : json(200, { v: 1, maxBlobBytes: 4096, requestTtlSeconds: 86400 });
    }
    let m = /^\/rooms\/([^/]+)\/listing$/.exec(path);
    if (m) {
      if (method === 'PUT') listings.set(m[1]!, (body as { blob: string }).blob);
      else listings.delete(m[1]!);
      return json(204);
    }
    if (path === '/team-sessions') {
      return json(200, {
        sessions: [...listings].map(([roomId, blob]) => ({
          roomId,
          blob,
          updatedAt: 1,
          lastActivity: 2,
          participants: 3,
        })),
      });
    }
    m = /^\/rooms\/([^/]+)\/join-requests(?:\/([^/]+))?$/.exec(path);
    if (m) {
      const list = requests.get(m[1]!) ?? [];
      if (method === 'POST') {
        const requestId = `rq${nextId++}`;
        list.push({ requestId, blob: (body as { blob: string }).blob, createdAt: Date.now() });
        requests.set(m[1]!, list);
        return json(201, { requestId });
      }
      if (method === 'DELETE') {
        requests.set(
          m[1]!,
          list.filter((r) => r.requestId !== decodeURIComponent(m![2]!)),
        );
        return json(204);
      }
      return json(200, { requests: list });
    }
    return json(404, { detail: 'Not Found' });
  }) as typeof fetch;
  return { calls, listings, requests, fetchImpl };
}

const BASE = 'https://relay.example/relay';

function ctxFor(relay: ReturnType<typeof fakeRelay>, teamKey = KEY): TeamContext {
  return {
    client: new RoomsClient({ baseUrl: () => BASE, token: () => 'tok', fetchImpl: relay.fetchImpl }),
    baseUrl: BASE,
    teamKey,
  };
}

let KEY = generateTeamKey();

beforeEach(() => {
  __resetTeamSessionsForTests();
  KEY = generateTeamKey();
});

// ── Crypto ────────────────────────────────────────────────────────────

describe('team key crypto', () => {
  it('round-trips a JSON value as base64url(nonce || ct || tag)', async () => {
    expect(isTeamKey(KEY)).toBe(true);
    expect(fromBase64Url(KEY).byteLength).toBe(32);
    const blob = await sealTeamBlob(KEY, { v: 1, name: 'Aff: K answers' });
    expect(blob).toMatch(/^[A-Za-z0-9_-]+$/);
    // 12-byte nonce + plaintext + 16-byte tag.
    const plainLen = new TextEncoder().encode(JSON.stringify({ v: 1, name: 'Aff: K answers' })).length;
    expect(fromBase64Url(blob).byteLength).toBe(12 + plainLen + 16);
    expect(await openTeamBlob(KEY, blob)).toEqual({ v: 1, name: 'Aff: K answers' });
    // A fresh nonce every time.
    expect(await sealTeamBlob(KEY, { a: 1 })).not.toBe(await sealTeamBlob(KEY, { a: 1 }));
  });

  it('opens to null with another key, a tampered blob, or junk', async () => {
    const blob = await sealTeamBlob(KEY, { a: 1 });
    expect(await openTeamBlob(generateTeamKey(), blob)).toBeNull();
    const bytes = fromBase64Url(blob);
    bytes[bytes.length - 1]! ^= 1;
    expect(await openTeamBlob(KEY, Buffer.from(bytes).toString('base64url'))).toBeNull();
    expect(await openTeamBlob(KEY, 'not a blob!')).toBeNull();
    expect(await openTeamBlob(KEY, '')).toBeNull();
  });

  it('interops with a plain AES-256-GCM implementation (node:crypto)', async () => {
    const { createDecipheriv } = await import('node:crypto');
    const blob = await sealTeamBlob(KEY, { x: 'y' });
    const raw = Buffer.from(blob, 'base64url');
    const d = createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'base64url'), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString('utf8');
    expect(JSON.parse(plain)).toEqual({ x: 'y' });
  });
});

// ── Key merge rules + the team file ───────────────────────────────────

describe('team key merge', () => {
  const other = generateTeamKey();
  it('adopts the file key when there is none locally', () => {
    expect(mergeTeamKey('', other)).toEqual({ key: other, adopted: true, conflict: false });
  });
  it('never replaces an existing key: keeps local and reports the conflict', () => {
    expect(mergeTeamKey(KEY, other)).toEqual({ key: KEY, adopted: false, conflict: true });
  });
  it('same key, or a file without one: nothing happens', () => {
    expect(mergeTeamKey(KEY, KEY)).toEqual({ key: KEY, adopted: false, conflict: false });
    expect(mergeTeamKey(KEY, undefined)).toEqual({ key: KEY, adopted: false, conflict: false });
    expect(mergeTeamKey('', 'garbage')).toEqual({ key: '', adopted: false, conflict: false });
  });

  it('the team file carries the key through build / serialize / parse, and drops a malformed one', () => {
    const f = buildTeamFile({ name: 'T', ownCode: ALEX, ownName: 'Alex', partners: [], groups: [], teamKey: KEY });
    expect(f.teamKey).toBe(KEY);
    expect(parseTeamFile(JSON.parse(serializeTeamFile(f)))?.teamKey).toBe(KEY);
    expect(parseTeamFile({ ...JSON.parse(serializeTeamFile(f)), teamKey: 'short' })?.teamKey).toBeUndefined();
  });

  it('adds a key to a file without one (other fields kept), never over an existing one', () => {
    const raw = { kind: 'cardmirror-team', version: 1, name: 'T', people: [], groups: [], note: 'hand edit' };
    const next = addTeamKeyToTeamFileJson(raw, KEY)!;
    expect(next['teamKey']).toBe(KEY);
    expect(next['note']).toBe('hand edit');
    expect(addTeamKeyToTeamFileJson(next, generateTeamKey())).toBeNull();
  });
});

// ── Payload shapes ────────────────────────────────────────────────────

describe('payloads', () => {
  it('a request listing has no share code; an open one does', () => {
    const base = { name: 'Aff: K answers', startedBy: 'Sam', shareCode: 'cmshare2.r.k.1.0.0' };
    expect(buildListingPayload({ ...base, mode: 'request' })).toEqual({
      v: 1,
      name: 'Aff: K answers',
      startedBy: 'Sam',
      mode: 'request',
      client: TEAM_SESSIONS_CLIENT,
    });
    expect(buildListingPayload({ ...base, mode: 'open' })).toEqual({
      v: 1,
      name: 'Aff: K answers',
      startedBy: 'Sam',
      mode: 'open',
      shareCode: 'cmshare2.r.k.1.0.0',
      client: TEAM_SESSIONS_CLIENT,
    });
    expect(TEAM_SESSIONS_CLIENT).toMatch(/^cardmirror-xtgg\/\d+\.\d+/);
  });

  it('a join request carries name, routing code, public key and client', async () => {
    const recipientCode = await routingIdFor(ALEX);
    expect(recipientCode).toBe(desktopRoutingId(ALEX)); // same derivation as the desktop mailbox
    expect(buildJoinRequestPayload({ name: 'Alex', recipientCode, publicKey: ALEX })).toEqual({
      v: 1,
      name: 'Alex',
      recipientCode,
      publicKey: ALEX,
      client: TEAM_SESSIONS_CLIENT,
    });
  });

  it('PUTs a sealed listing the team can read back', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    expect(
      await listRoom(ctx, { roomId: 'r1', name: 'Neg', startedBy: 'Sam', mode: 'request', shareCode: 'cmshare1.r1.k' }),
    ).toBe(true);
    const put = relay.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/rooms/r1/listing');
    expect(Object.keys(put.body as object)).toEqual(['blob']);
    expect(JSON.stringify(put.body)).not.toContain('Neg'); // opaque to the relay
    expect(listedMode('r1')).toBe('request');
    const rows = await loadTeamSessions(ctx);
    expect(rows).toEqual([
      { roomId: 'r1', name: 'Neg', startedBy: 'Sam', mode: 'request', shareCode: null, participants: 3, lastActivity: 2, people: [] },
    ]);
    // The host can say who's in it (sealed like the rest); older listings just don't.
    await listRoom(ctx, { roomId: 'r1', name: 'Neg', startedBy: 'Sam', mode: 'request', shareCode: 'cmshare1.r1.k', people: ['Sam', 'Ana'] });
    expect(JSON.stringify(relay.calls.at(-1)!.body)).not.toContain('Ana');
    expect((await loadTeamSessions(ctx))?.[0]?.people).toEqual(['Sam', 'Ana']);
  });
});

// ── Discovery gating ──────────────────────────────────────────────────

describe('discovery', () => {
  it('an unsupported relay gets one discovery GET and nothing else', async () => {
    const relay = fakeRelay({ supported: false });
    const ctx = ctxFor(relay);
    expect(await teamSessionsSupport(ctx.client, BASE)).toBeNull();
    expect(
      await listRoom(ctx, { roomId: 'r1', name: 'N', startedBy: 'S', mode: 'request', shareCode: 'cmshare1.r1.k' }),
    ).toBe(false);
    expect(await loadTeamSessions(ctx)).toBeNull();
    expect(await requestToJoin(ctx, 'r1', { name: 'Alex', publicCode: ALEX })).toBe('failed');
    expect(relay.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /ext/team-sessions/v1']);
  });

  it('caches per base URL; a different relay is checked again', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    expect(await teamSessionsSupport(ctx.client, BASE)).toEqual({ v: 1, maxBlobBytes: 4096, requestTtlSeconds: 86400 });
    await teamSessionsSupport(ctx.client, BASE);
    await teamSessionsSupport(ctx.client, `${BASE}/`);
    expect(relay.calls.length).toBe(1);
    await teamSessionsSupport(ctx.client, 'https://other.example/r/team');
    expect(relay.calls.length).toBe(2);
  });

  it('a network failure is not cached', async () => {
    let fail = true;
    const relay = fakeRelay();
    const fetchImpl = ((i: RequestInfo | URL, n?: RequestInit) =>
      fail ? Promise.reject(new TypeError('offline')) : relay.fetchImpl(i, n)) as typeof fetch;
    const client = new RoomsClient({ baseUrl: () => BASE, token: () => 'tok', fetchImpl });
    expect(await teamSessionsSupport(client, BASE)).toBeNull();
    fail = false;
    expect(await teamSessionsSupport(client, BASE)).not.toBeNull();
  });

  it('without a team key nothing is listed or loaded', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay, '');
    expect(
      await listRoom(ctx, { roomId: 'r1', name: 'N', startedBy: 'S', mode: 'request', shareCode: 'cmshare1.r1.k' }),
    ).toBe(false);
    expect(await loadTeamSessions(ctx)).toBeNull();
    expect(relay.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

// ── Join dialog listing ───────────────────────────────────────────────

describe('loading team sessions', () => {
  it('skips entries that do not decrypt with our key', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    await listRoom(ctx, { roomId: 'mine', name: 'Ours', startedBy: 'Sam', mode: 'open', shareCode: 'cmshare1.mine.k' });
    relay.listings.set('theirs', await sealTeamBlob(generateTeamKey(), buildListingPayload({
      name: 'Theirs', startedBy: 'X', mode: 'open', shareCode: 'cmshare1.theirs.k',
    })));
    relay.listings.set('junk', 'AAAA');
    const rows = await loadTeamSessions(ctx);
    expect(rows?.map((r) => [r.roomId, r.mode, r.shareCode])).toEqual([['mine', 'open', 'cmshare1.mine.k']]);
  });
});

// ── Requests, approvals, errors ───────────────────────────────────────

async function pendingFor(ctx: TeamContext, roomId: string): Promise<PendingJoinRequest[]> {
  return fetchJoinRequests(ctx, roomId);
}

describe('join requests', () => {
  it('a request round-trips to the participant, decrypted', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    expect(await requestToJoin(ctx, 'r1', { name: 'Alex', publicCode: ALEX })).toBe('sent');
    const [req] = await pendingFor(ctx, 'r1');
    expect(req).toMatchObject({ roomId: 'r1', name: 'Alex', publicKey: ALEX, recipientCode: desktopRoutingId(ALEX) });
  });

  it('approve sends the invite to the requester’s key, then deletes the request', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    await requestToJoin(ctx, 'r1', { name: 'Alex', publicCode: ALEX });
    const [req] = await pendingFor(ctx, 'r1');
    const order: string[] = [];
    const sendInvite = vi.fn(async (publicKey: string, name: string) => {
      order.push(`send ${name}`);
      expect(publicKey).toBe(ALEX);
      return true;
    });
    expect(await approveJoinRequest(ctx.client, req!, sendInvite)).toBe('sent');
    expect(sendInvite).toHaveBeenCalledOnce();
    const del = relay.calls.filter((c) => c.method === 'DELETE');
    expect(del.map((c) => c.path)).toEqual([`/rooms/r1/join-requests/${req!.requestId}`]);
    expect(await pendingFor(ctx, 'r1')).toEqual([]);
  });

  it('approve keeps the request when the invite could not be sent', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    await requestToJoin(ctx, 'r1', { name: 'Alex', publicCode: ALEX });
    const [req] = await pendingFor(ctx, 'r1');
    expect(await approveJoinRequest(ctx.client, req!, async () => false)).toBe('failed');
    expect(relay.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('approve refuses a request whose routing code does not match its key (no send)', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    const send = vi.fn(async () => true);
    const req: PendingJoinRequest = {
      roomId: 'r1', requestId: 'x', name: 'Alex', publicKey: ALEX, recipientCode: 'wrong', createdAt: 0,
    };
    expect(await approveJoinRequest(ctx.client, req, send)).toBe('mismatch');
    expect(send).not.toHaveBeenCalled();
  });

  it('deny on an already-handled request is fine (first action wins)', async () => {
    const relay = fakeRelay({ status: { 'DELETE /rooms/r1/join-requests/gone': 404 } });
    const ctx = ctxFor(relay);
    await expect(denyJoinRequest(ctx.client, 'r1', 'gone')).resolves.toBeUndefined();
    await expect(denyJoinRequest(ctx.client, 'r1', 'other')).resolves.toBeUndefined();
  });

  it('a request to an ended or unlisted room reads as gone', async () => {
    const relay = fakeRelay({ status: { 'POST /rooms/r9/join-requests': 410, 'POST /rooms/r8/join-requests': 403 } });
    const ctx = ctxFor(relay);
    expect(await requestToJoin(ctx, 'r9', { name: 'Alex', publicCode: ALEX })).toBe('gone');
    expect(await requestToJoin(ctx, 'r8', { name: 'Alex', publicCode: ALEX })).toBe('gone');
  });
});

describe('relay errors', () => {
  it('a listing refused with 403/410 is forgotten and reported false, never thrown', async () => {
    const relay = fakeRelay({ status: { 'PUT /rooms/r1/listing': 403, 'PUT /rooms/r2/listing': 410 } });
    const ctx = ctxFor(relay);
    for (const roomId of ['r1', 'r2']) {
      expect(
        await listRoom(ctx, { roomId, name: 'N', startedBy: 'S', mode: 'request', shareCode: 'cmshare1.x.k' }),
      ).toBe(false);
      expect(listedMode(roomId)).toBeNull();
    }
  });

  it('unlist only calls the relay for a room this machine listed', async () => {
    const relay = fakeRelay();
    const ctx = ctxFor(relay);
    await unlistRoom(ctx.client, 'never-listed');
    expect(relay.calls).toEqual([]);
    await listRoom(ctx, { roomId: 'r1', name: 'N', startedBy: 'S', mode: 'request', shareCode: 'cmshare1.r1.k' });
    await unlistRoom(ctx.client, 'r1');
    expect(relay.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/rooms/r1/listing' });
    expect(listedMode('r1')).toBeNull();
  });

  describe('the join-request watcher', () => {
    afterEach(() => vi.useRealTimers());

    async function hostWatcher(relay: ReturnType<typeof fakeRelay>, hidden = () => false) {
      const ctx = ctxFor(relay);
      await listRoom(ctx, { roomId: 'r1', name: 'N', startedBy: 'S', mode: 'request', shareCode: 'cmshare1.r1.k' });
      const seen: PendingJoinRequest[][] = [];
      const w = watchJoinRequests({
        roomId: 'r1',
        role: 'host',
        context: () => ctx,
        onRequests: (r) => seen.push(r),
        isHidden: hidden,
        intervalMs: 60_000,
      });
      return { ctx, seen, w };
    }

    it('reports pending requests, skipping our own', async () => {
      const relay = fakeRelay();
      const { ctx, seen, w } = await hostWatcher(relay);
      await requestToJoin(ctx, 'r1', { name: 'Alex', publicCode: ALEX });
      await w.tick();
      expect(seen.at(-1)?.map((r) => r.name)).toEqual(['Alex']);
      w.stop();
    });

    it('stops quietly on 403/404/410', async () => {
      for (const status of [403, 404, 410]) {
        __resetTeamSessionsForTests();
        const relay = fakeRelay({ status: { 'GET /rooms/r1/join-requests': status } });
        const { seen, w } = await hostWatcher(relay);
        await w.tick();
        const before = relay.calls.length;
        await w.tick();
        expect(relay.calls.length).toBe(before); // dropped: no more calls
        expect(seen.at(-1)).toEqual([]);
      }
    });

    it('keeps going after a transient error', async () => {
      const relay = fakeRelay({ status: { 'GET /rooms/r1/join-requests': 503 } });
      const { w } = await hostWatcher(relay);
      await w.tick();
      const before = relay.calls.length;
      await w.tick();
      expect(relay.calls.length).toBeGreaterThan(before);
      w.stop();
    });

    it('does not poll while the window is hidden', async () => {
      const relay = fakeRelay();
      let hidden = true;
      const { w } = await hostWatcher(relay, () => hidden);
      const before = relay.calls.length;
      await w.tick();
      expect(relay.calls.length).toBe(before);
      hidden = false;
      await w.tick();
      expect(relay.calls.length).toBeGreaterThan(before);
      w.stop();
    });

    it('a participant polls only when the room is listed as request', async () => {
      const relay = fakeRelay();
      const ctx = ctxFor(relay);
      await listRoom(ctx, { roomId: 'open1', name: 'N', startedBy: 'S', mode: 'open', shareCode: 'cmshare1.open1.k' });
      const w = watchJoinRequests({
        roomId: 'open1',
        role: 'participant',
        context: () => ctx,
        onRequests: () => {},
        isHidden: () => false,
        intervalMs: 60_000,
      });
      await w.tick();
      expect(relay.calls.some((c) => c.path === '/rooms/open1/join-requests')).toBe(false);
      w.stop();
    });
  });
});

// ── The Join dialog's Team sessions section ───────────────────────────

describe('Join dialog team section', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const rows = [
    { roomId: 'o', name: 'Open one', startedBy: 'Sam', participants: 2, lastActivity: Date.now(), mode: 'open' as const, shareCode: 'cmshare1.o.k' },
    { roomId: 'q', name: 'Ask first', startedBy: 'Kim', participants: 1, lastActivity: Date.now(), mode: 'request' as const, shareCode: null },
  ];

  it('is absent without a source', async () => {
    const p = pickSessionToJoin([]);
    await Promise.resolve();
    expect(document.querySelector('.pmd-rejoin-team')).toBeNull();
    (document.querySelector('.pmd-route-cancel') as HTMLButtonElement).click();
    expect(await p).toBeNull();
  });

  it('Join on an open session resolves with its share code', async () => {
    const p = pickSessionToJoin([], {
      load: async () => rows,
      request: async () => ({ ok: true, message: TEAM_REQUEST_SENT_MESSAGE }),
      alreadyRequested: () => false,
    });
    await vi.waitFor(() => expect(document.querySelectorAll('.pmd-rejoin-team-btn').length).toBe(2));
    const text = document.querySelector('.pmd-rejoin-team')!.textContent!;
    expect(text).toContain('Open one');
    expect(text).toContain('2 people in it · started by Sam');
    const [join, ask] = [...document.querySelectorAll<HTMLButtonElement>('.pmd-rejoin-team-btn')];
    expect(ask!.textContent).toBe('Request to join');
    join!.click();
    expect(await p).toEqual({ kind: 'rejoin', shareCode: 'cmshare1.o.k', guestPass: null });
  });

  it('Request to join sends and says so, keeping the dialog open', async () => {
    const request = vi.fn(async () => ({ ok: true, message: TEAM_REQUEST_SENT_MESSAGE }));
    const p = pickSessionToJoin([], { load: async () => rows, request, alreadyRequested: () => false });
    await vi.waitFor(() => expect(document.querySelectorAll('.pmd-rejoin-team-btn').length).toBe(2));
    const ask = document.querySelectorAll<HTMLButtonElement>('.pmd-rejoin-team-btn')[1]!;
    ask.click();
    await vi.waitFor(() => expect(ask.textContent).toBe('Request sent'));
    expect(request).toHaveBeenCalledWith(rows[1]);
    expect(document.querySelector('.pmd-rejoin-team-note')!.textContent).toBe(TEAM_REQUEST_SENT_MESSAGE);
    (document.querySelector('.pmd-route-cancel') as HTMLButtonElement).click();
    expect(await p).toBeNull();
  });

  it('stays hidden when the feature is off for this relay (load → null)', async () => {
    const p = pickSessionToJoin([], { load: async () => null, request: vi.fn(), alreadyRequested: () => false });
    await new Promise((r) => setTimeout(r, 0));
    expect((document.querySelector('.pmd-rejoin-team') as HTMLElement).hidden).toBe(true);
    (document.querySelector('.pmd-route-cancel') as HTMLButtonElement).click();
    await p;
  });
});
