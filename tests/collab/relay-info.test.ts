// @vitest-environment jsdom
/**
 * Relay info (relay extension v1): the request headers and their encoding
 * and length cap, the "show my name" toggle, the info document's parsing
 * (missing and unknown fields), discovery (404 / errors → nothing), the
 * fetch cadence, notice dedupe and expiry, and the update hint's version
 * compare — against a fake relay (fetchImpl).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { RoomsClient, RoomStream } from '../../src/editor/collab/room-client.js';
import {
  activeNotice,
  currentRelayInfo,
  customRelayExtHeaders,
  customRelayInstallHeader,
  installNameToSend,
  installsLine,
  parseRelayInfo,
  refreshRelayInfo,
  updateHint,
  RELAY_INFO_REFRESH_MS,
  __resetRelayInfoForTests,
  type RelayInfo,
} from '../../src/editor/collab/relay-info.js';
import { relayInfoRows, syncRelayNotice, __resetRelayInfoUiForTests } from '../../src/editor/collab/relay-info-ui.js';
import {
  encodeInstallName,
  relayClientHeaderValue,
  relayExtHeaders,
  RELAY_CLIENT_ID,
  RELAY_EXT_CLIENT_HEADER,
  RELAY_EXT_INSTALL_HEADER,
  RELAY_EXT_INSTALL_NAME_HEADER,
} from '../../src/editor/relay-protocol.js';
import { appVersion } from '../../src/editor/install-info.js';
import { settings } from '../../src/editor/settings.js';
import {
  __dismissNoticeForTests,
  __noticesForTests,
  __resetNoticesForTests,
} from '../../src/editor/status-notices.js';

const FULL_DOC = {
  v: 1,
  operator: {
    name: 'Example Relay',
    url: 'https://relay.example/about',
    support: 'help@relay.example',
    status: 'https://status.relay.example',
    manage: 'https://relay.example/manage',
  },
  access: {
    label: 'Duo, season',
    status: 'active',
    expiresAt: 1785542400000,
    installs: { used: 3, max: 4, idleDays: 30 },
  },
  notice: { id: '2026-10-25-maint', text: 'Maintenance Saturday 2-3am ET.', until: 1792900800000 },
  clients: [
    { id: 'example-build', name: 'Example build', latest: '1.15.22', url: 'https://example.org/releases/latest' },
  ],
};

const decodedBytes = (v: string): number => new TextEncoder().encode(decodeURIComponent(v)).length;

// ── A fake relay ──────────────────────────────────────────────────────

function fakeRelay(answer: () => Response | Promise<Response>) {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = new RoomsClient({
    baseUrl: () => 'https://relay.example/relay',
    token: () => 'tok',
    extHeaders: () => customRelayExtHeaders(),
    fetchImpl: async (input, init) => {
      sent.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      return answer();
    },
  });
  return { client, sent, ctx: { client, baseUrl: 'https://relay.example/relay' } };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  __resetRelayInfoForTests();
  __resetNoticesForTests();
  __resetRelayInfoUiForTests();
  settings.set('pairingRelayUrl', 'https://relay.example/relay');
  settings.set('pairingDisplayName', 'Sam');
  settings.set('relayShowInstallName', true);
  settings.set('relayInfoDismissedNotices', []);
});

// ── headers ───────────────────────────────────────────────────────────

describe('relay info headers', () => {
  it('names this build as cardmirror-xtgg/<package version>', () => {
    expect(RELAY_CLIENT_ID).toBe('cardmirror-xtgg');
    expect(relayClientHeaderValue(appVersion)).toBe(`cardmirror-xtgg/${appVersion}`);
    expect(relayClientHeaderValue('1.15.22-beta.1')).toBe('cardmirror-xtgg/1.15.22-beta.1');
  });

  it('keeps the client header to the spec alphabet and 64 bytes', () => {
    expect(relayClientHeaderValue('1.2.3 (dev)/x')).toBe('cardmirror-xtgg/1.2.3devx');
    expect(relayClientHeaderValue('')).toBe('cardmirror-xtgg');
    const long = relayClientHeaderValue('9'.repeat(200));
    expect(long.length).toBe(64);
    expect(long).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
  });

  it("percent-encodes the install name like the spec's example", () => {
    expect(encodeInstallName("Sam's MacBook")).toBe('Sam%27s%20MacBook');
    expect(encodeInstallName('  Ana  María \n')).toBe('Ana%20Mar%C3%ADa');
    expect(encodeInstallName('   ')).toBe('');
    expect(encodeInstallName('a\u0000b')).toBe('a%20b');
  });

  it('caps the install name at 64 bytes after decoding, on a character boundary', () => {
    const ascii = encodeInstallName('x'.repeat(100));
    expect(decodedBytes(ascii)).toBe(64);
    // 3-byte characters: 21 fit (63 bytes), the 22nd would be 66.
    const cjk = encodeInstallName('東'.repeat(40));
    expect(decodeURIComponent(cjk)).toBe('東'.repeat(21));
    expect(decodedBytes(cjk)).toBe(63);
    // 4-byte emoji are never split.
    const emoji = encodeInstallName('😀'.repeat(20));
    expect(decodeURIComponent(emoji)).toBe('😀'.repeat(16));
  });

  it('sends the install name only when there is one', () => {
    expect(relayExtHeaders({ version: '1.0.0', installName: 'Sam' })).toEqual({
      [RELAY_EXT_CLIENT_HEADER]: 'cardmirror-xtgg/1.0.0',
      [RELAY_EXT_INSTALL_NAME_HEADER]: 'Sam',
    });
    expect(relayExtHeaders({ version: '1.0.0', installName: '' })).toEqual({
      [RELAY_EXT_CLIENT_HEADER]: 'cardmirror-xtgg/1.0.0',
    });
  });

  it('the name toggle: on → display name, off → nothing, no display name → nothing', () => {
    expect(installNameToSend({ relayShowInstallName: true, pairingDisplayName: ' Sam ' })).toBe('Sam');
    expect(installNameToSend({ relayShowInstallName: false, pairingDisplayName: 'Sam' })).toBe('');
    expect(installNameToSend({ relayShowInstallName: true, pairingDisplayName: '' })).toBe('');
    expect(settings.get('relayShowInstallName')).toBe(true); // default on
  });

  it('only on a custom relay', () => {
    const st = { pairingRelayUrl: '', relayShowInstallName: true, pairingDisplayName: 'Sam' };
    expect(customRelayExtHeaders(st)).toEqual({});
    expect(customRelayExtHeaders({ ...st, pairingRelayUrl: 'https://r.example/relay' })).toEqual({
      [RELAY_EXT_CLIENT_HEADER]: `cardmirror-xtgg/${appVersion}`,
      [RELAY_EXT_INSTALL_NAME_HEADER]: 'Sam',
    });
  });

  it('ride along on rooms requests, following the live settings', async () => {
    const { client, sent } = fakeRelay(() => json({ roomId: 'r1' }));
    await client.createRoom();
    expect(sent[0]!.headers[RELAY_EXT_CLIENT_HEADER]).toBe(`cardmirror-xtgg/${appVersion}`);
    expect(sent[0]!.headers[RELAY_EXT_INSTALL_NAME_HEADER]).toBe('Sam');
    expect(sent[0]!.headers['X-CardMirror-Version']).toBe(appVersion);

    settings.set('relayShowInstallName', false);
    await client.createRoom();
    expect(sent[1]!.headers[RELAY_EXT_INSTALL_NAME_HEADER]).toBeUndefined();
    expect(sent[1]!.headers[RELAY_EXT_CLIENT_HEADER]).toBeDefined();

    settings.set('pairingRelayUrl', '');
    await client.createRoom();
    expect(sent[2]!.headers[RELAY_EXT_CLIENT_HEADER]).toBeUndefined();
  });
});

describe('X-Relay-Install (room create and room stream)', () => {
  const CODE = 'cmk1.8pB2ioOXJb-pIuFgTYKVUgJWuPclbI5k3i5x1m32324';
  const ROUTING = createHash('sha256').update(Buffer.from(CODE.slice(5), 'base64url')).digest().subarray(0, 16).toString('base64url');

  function client(sent: Array<{ url: string; headers: Record<string, string> }>) {
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } });
      return new Response(JSON.stringify({ roomId: 'r1', seq: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return new RoomsClient({
      baseUrl: () => 'https://relay.example/relay',
      token: () => 'tok',
      extHeaders: () => customRelayExtHeaders(),
      installHeader: () => customRelayInstallHeader(),
      fetchImpl,
    });
  }

  it('is the routing code the mailbox polls with, on a custom relay only', async () => {
    settings.set('pairingOwnCode', CODE);
    expect(ROUTING).toBe('BAv-el6lu4RdVysJCWlDag'); // pairing-crypto routingId of this key (mailbox-proof vector)
    expect(await customRelayInstallHeader({ pairingRelayUrl: 'https://r.example/relay' })).toEqual({ [RELAY_EXT_INSTALL_HEADER]: ROUTING });
    expect(await customRelayInstallHeader({ pairingRelayUrl: '' })).toEqual({});
    settings.set('pairingOwnCode', '');
    expect(await customRelayInstallHeader({ pairingRelayUrl: 'https://r.example/relay' })).toEqual({});
  });

  it('rides on room create and the room stream, not on other room calls', async () => {
    settings.set('pairingOwnCode', CODE);
    const sent: Array<{ url: string; headers: Record<string, string> }> = [];
    const c = client(sent);
    await c.createRoom();
    await c.postUpdate('r1', new Uint8Array([1]));
    expect(sent[0]!.headers[RELAY_EXT_INSTALL_HEADER]).toBe(ROUTING);
    expect(sent[1]!.headers[RELAY_EXT_INSTALL_HEADER]).toBeUndefined();
    const stream = new RoomStream({
      baseUrl: c.opts.baseUrl,
      token: c.opts.token,
      extHeaders: c.opts.extHeaders,
      installHeader: c.opts.installHeader,
      fetchImpl: c.opts.fetchImpl,
      roomId: 'r1',
      callbacks: { onHello: () => {}, onUpdate: () => {}, onEnded: () => {} } as never,
      minBackoffMs: 60_000,
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 20));
    stream.stop();
    const st = sent.find((x) => x.url.includes('/rooms/r1/stream'))!;
    expect(st.headers[RELAY_EXT_INSTALL_HEADER]).toBe(ROUTING);
    // The built-in relay never gets it.
    settings.set('pairingRelayUrl', '');
    await c.createRoom();
    expect(sent.at(-1)!.headers[RELAY_EXT_INSTALL_HEADER]).toBeUndefined();
  });
});

// ── the info document ─────────────────────────────────────────────────

describe('parseRelayInfo', () => {
  it('reads the spec example', () => {
    const info = parseRelayInfo(FULL_DOC)!;
    // Links come back normalized by URL (a bare origin gains its '/').
    expect(info.operator).toEqual({ ...FULL_DOC.operator, status: 'https://status.relay.example/' });
    expect(info.access).toEqual({
      label: 'Duo, season',
      status: 'active',
      expiresAt: 1785542400000,
      installs: { used: 3, max: 4, idleDays: 30 },
    });
    expect(info.notice).toEqual(FULL_DOC.notice);
    expect(info.clients[0]).toMatchObject({ id: 'example-build', latest: '1.15.22', note: '' });
  });

  it('needs v: 1 and nothing else', () => {
    expect(parseRelayInfo({ v: 1 })).toEqual({ v: 1, operator: null, access: null, notice: null, clients: [] });
    expect(parseRelayInfo({ v: 2, operator: { name: 'X' } })).toBeNull();
    expect(parseRelayInfo({ operator: { name: 'X' } })).toBeNull();
    expect(parseRelayInfo(null)).toBeNull();
    expect(parseRelayInfo([1])).toBeNull();
    expect(parseRelayInfo('{"v":1}')).toBeNull();
  });

  it('ignores unknown fields and drops malformed ones', () => {
    const info = parseRelayInfo({
      v: 1,
      future: { anything: true },
      operator: { name: 42, url: 'http://insecure.example', support: 'not an email', status: 'javascript:alert(1)', extra: 1 },
      access: { status: 'weird', expiresAt: 'soon', installs: { used: -1, max: -1, idleDays: 'x' } },
      notice: { id: 'n1' },
      clients: [null, { name: 'no id' }, ...Array.from({ length: 8 }, (_, i) => ({ id: `c${i}` }))],
    })!;
    expect(info.operator).toBeNull();
    expect(info.access).toEqual({
      label: '',
      status: '',
      expiresAt: null,
      installs: { used: null, max: null, idleDays: null },
    });
    expect(info.notice).toBeNull(); // no text
    // At most 5 entries are looked at; the junk ones among them are skipped.
    expect(info.clients.map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
  });

  it('caps the notice text at 280 characters', () => {
    const info = parseRelayInfo({ v: 1, notice: { id: 'n', text: 'y'.repeat(400) } })!;
    expect(info.notice!.text.length).toBe(280);
    expect(info.notice!.until).toBeNull();
  });
});

// ── discovery and cadence ─────────────────────────────────────────────

describe('refreshRelayInfo', () => {
  it('GETs /ext/relay-info/v1 with the headers', async () => {
    const { ctx, sent } = fakeRelay(() => json(FULL_DOC));
    const info = await refreshRelayInfo(ctx, { now: 1000 });
    expect(sent[0]!.url).toBe('https://relay.example/relay/ext/relay-info/v1');
    expect(sent[0]!.headers['Authorization']).toBe('Bearer tok');
    expect(sent[0]!.headers[RELAY_EXT_CLIENT_HEADER]).toBe(`cardmirror-xtgg/${appVersion}`);
    expect(info?.operator?.name).toBe('Example Relay');
    expect(currentRelayInfo()).toBe(info);
  });

  it('404 means unsupported: nothing to show', async () => {
    const { ctx } = fakeRelay(() => json({ detail: 'not found' }, 404));
    expect(await refreshRelayInfo(ctx, { now: 1000 })).toBeNull();
    expect(currentRelayInfo()).toBeNull();
    expect(relayInfoRows(currentRelayInfo())).toEqual([]);
    expect(__noticesForTests()).toHaveLength(0);
  });

  it('any other error, an HTML page or a non-v1 body also shows nothing', async () => {
    for (const res of [
      () => json({}, 500),
      () => json({}, 401),
      () => new Response('<!doctype html><p>portal</p>', { status: 200 }),
      () => json({ v: 2 }),
    ]) {
      __resetRelayInfoForTests();
      expect(await refreshRelayInfo(fakeRelay(res).ctx, { now: 1000 })).toBeNull();
    }
  });

  it('fetches at most hourly; a forced refresh (settings opened) refetches', async () => {
    const { ctx, sent } = fakeRelay(() => json(FULL_DOC));
    await refreshRelayInfo(ctx, { now: 0 });
    await refreshRelayInfo(ctx, { now: RELAY_INFO_REFRESH_MS - 1 });
    expect(sent).toHaveLength(1);
    await refreshRelayInfo(ctx, { now: 10_000, force: true });
    expect(sent).toHaveLength(2);
    await refreshRelayInfo(ctx, { now: 11_000, force: true }); // folded
    expect(sent).toHaveLength(2);
    await refreshRelayInfo(ctx, { now: 10_000 + RELAY_INFO_REFRESH_MS });
    expect(sent).toHaveLength(3);
  });

  it('a network failure keeps what was shown; a refusal clears it', async () => {
    let mode: 'ok' | 'down' | 'gone' = 'ok';
    const { ctx } = fakeRelay(() => {
      if (mode === 'down') throw new TypeError('fetch failed');
      return mode === 'ok' ? json(FULL_DOC) : json({}, 404);
    });
    await refreshRelayInfo(ctx, { now: 0 });
    mode = 'down';
    await refreshRelayInfo(ctx, { now: 0, force: true });
    expect(await refreshRelayInfo(ctx, { now: RELAY_INFO_REFRESH_MS + 1 })).not.toBeNull();
    mode = 'gone';
    expect(await refreshRelayInfo(ctx, { now: 3 * RELAY_INFO_REFRESH_MS })).toBeNull();
  });

  it('no custom relay clears it', async () => {
    await refreshRelayInfo(fakeRelay(() => json(FULL_DOC)).ctx, { now: 0 });
    expect(await refreshRelayInfo(null)).toBeNull();
    expect(currentRelayInfo()).toBeNull();
  });
});

// ── notice ────────────────────────────────────────────────────────────

describe('relay notice', () => {
  const info = (notice: unknown): RelayInfo => parseRelayInfo({ ...FULL_DOC, notice })!;
  const N = { id: 'maint-1', text: 'Maintenance Saturday.', until: 5000 };

  it('activeNotice: not after until, not once dismissed', () => {
    expect(activeNotice(info(N), [], 4999)?.id).toBe('maint-1');
    expect(activeNotice(info(N), [], 5000)).toBeNull();
    expect(activeNotice(info(N), ['maint-1'], 0)).toBeNull();
    expect(activeNotice(info({ id: 'x', text: 'no end' }), [], 9e15)?.id).toBe('x');
    expect(activeNotice(null, [], 0)).toBeNull();
  });

  it('is posted once per id, however often the relay repeats it', () => {
    syncRelayNotice(info(N), 0);
    syncRelayNotice(info(N), 10);
    syncRelayNotice(info(N), 20);
    const posted = __noticesForTests();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ key: 'relay-notice:maint-1', body: 'Maintenance Saturday.', count: 1 });
    expect(posted[0]!.title).toBe('Notice from Example Relay');
  });

  it('a dismissed id is remembered and never shown again', () => {
    syncRelayNotice(info(N), 0);
    __dismissNoticeForTests('relay-notice:maint-1');
    expect(settings.get('relayInfoDismissedNotices')).toEqual(['maint-1']);
    syncRelayNotice(info(N), 10);
    expect(__noticesForTests()).toHaveLength(0);
    // A new id (the text changed) shows.
    syncRelayNotice(info({ ...N, id: 'maint-2' }), 20);
    expect(__noticesForTests().map((n) => n.key)).toEqual(['relay-notice:maint-2']);
  });

  it('comes down when until passes, or when the relay drops or replaces it', () => {
    syncRelayNotice(info(N), 0);
    syncRelayNotice(info(N), 5000);
    expect(__noticesForTests()).toHaveLength(0);
    syncRelayNotice(info({ id: 'a', text: 'A' }), 0);
    syncRelayNotice(info({ id: 'b', text: 'B' }), 0);
    expect(__noticesForTests().map((n) => n.key)).toEqual(['relay-notice:b']);
    syncRelayNotice(info(null), 0);
    expect(__noticesForTests()).toHaveLength(0);
  });
});

// ── update hint and the About block ───────────────────────────────────

describe('update hint', () => {
  const withClients = (clients: unknown[]): RelayInfo => parseRelayInfo({ v: 1, clients })!;
  const own = (latest: string, url = 'https://example.org/rel') => ({ id: 'cardmirror-xtgg', latest, url });

  it('only for this build’s own id, only when newer', () => {
    expect(updateHint(withClients([own('1.15.22')]), '1.15.21')).toEqual({ latest: '1.15.22', url: 'https://example.org/rel' });
    expect(updateHint(withClients([own('1.15.21')]), '1.15.21')).toBeNull();
    expect(updateHint(withClients([own('1.15.9')]), '1.15.21')).toBeNull(); // numeric, not string, compare
    expect(updateHint(withClients([own('1.16.0')]), '1.15.21')).not.toBeNull();
    expect(updateHint(withClients([own('2.0.0')]), '1.99.99')).not.toBeNull();
    expect(updateHint(withClients([{ ...own('9.0.0'), id: 'example-build' }]), '1.15.21')).toBeNull();
  });

  it('prereleases and junk', () => {
    expect(updateHint(withClients([own('1.15.22-beta.1')]), '1.15.21')).not.toBeNull();
    expect(updateHint(withClients([own('1.15.22-beta.1')]), '1.15.22')).toBeNull();
    expect(updateHint(withClients([own('1.15.22')]), '1.15.22-rc.2')).not.toBeNull();
    expect(updateHint(withClients([own('latest')]), '1.15.21')).toBeNull();
    expect(updateHint(withClients([own('')]), '1.15.21')).toBeNull();
  });

  it('needs an https link', () => {
    expect(updateHint(withClients([own('9.0.0', 'http://example.org/rel')]), '1.0.0')).toBeNull();
    expect(updateHint(withClients([{ id: 'cardmirror-xtgg', latest: '9.0.0' }]), '1.0.0')).toBeNull();
  });
});

describe('About this relay', () => {
  it('installs line', () => {
    expect(installsLine({ used: 3, max: 4, idleDays: 30 })).toBe('Installs: 3 of 4 in use; unused for 30 days stop counting');
    expect(installsLine({ used: 2, max: null, idleDays: null })).toBe('Installs: 2 in use');
    expect(installsLine({ used: null, max: null, idleDays: null })).toBe('');
    expect(installsLine(null)).toBe('');
  });

  it('rows come only from the document; links are https and mailto', () => {
    const doc = { ...FULL_DOC, clients: [{ id: 'cardmirror-xtgg', latest: '999.0.0', url: 'https://example.org/rel' }] };
    const rows = relayInfoRows(parseRelayInfo(doc));
    const byLabel = new Map(rows.map(([l, n]) => [l, n]));
    // Compact: who runs it on one line, your access without the operator's label.
    expect([...byLabel.keys()]).toEqual(['Relay', 'Your access', 'Installs', 'This app']);
    const links = [...(byLabel.get('Relay') as HTMLElement).querySelectorAll('a')].map((x) => [x.textContent, x.href]);
    expect(links).toEqual([
      ['Example Relay', 'https://relay.example/about'],
      ['Support', 'mailto:help@relay.example'],
      ['Status', expect.stringMatching(/^https:/)],
    ]);
    expect(byLabel.get('Your access')!.textContent).toMatch(/^Active · until /);
    expect(byLabel.get('Installs')!.textContent).toBe('3 of 4 in use; unused for 30 days stop counting');
    expect(byLabel.get('This app')!.textContent).toBe('Update available (999.0.0)');
    expect(relayInfoRows(parseRelayInfo({ v: 1 }))).toEqual([]);
  });
});
