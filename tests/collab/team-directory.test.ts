// @vitest-environment jsdom
/**
 * Team directory (relay extension v1): parsing (malformed entries,
 * non-v1), merge equivalence with a team file import, the offer and "Not
 * now" (per revision), registration on Import (only our own code and
 * name), the conditional re-fetch (If-None-Match / 304) and quiet merge,
 * the team key both ways (push when the team has none, 409, adopt), the
 * re-register on a name change, and discovery 404 / errors → nothing —
 * against a fake relay (fetchImpl).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const toasts = vi.hoisted(() => [] as string[]);
const prompt = vi.hoisted(() => ({ answer: null as string | null, asked: [] as Array<{ message: string; initial?: string }> }));

vi.mock('../../src/editor/toast.js', () => ({ showToast: (m: string) => toasts.push(m) }));
vi.mock('../../src/editor/text-prompt.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/text-prompt.js')>();
  return {
    ...mod,
    promptForText: async (opts: { message: string; initial?: string }) => {
      prompt.asked.push(opts);
      return prompt.answer;
    },
  };
});
// The UI resolves its relay context from collab-relay; point it at the fake.
const relayRef = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../../src/editor/collab/collab-relay.js', () => ({
  ensureBakedRelay: async () => {},
  relayBaseUrl: () => 'https://relay.example/relay',
  relayClient: () => relayRef.client,
}));

import { RoomsClient } from '../../src/editor/collab/room-client.js';
import {
  currentOffer,
  directoryKey,
  directoryState,
  dismissOffer,
  importTeamDirectory,
  mergeTeamDirectory,
  missingPeople,
  onTeamDirectoryOffer,
  parseTeamDirectory,
  parseTeamDirectorySupport,
  refreshTeamDirectory,
  shouldOffer,
  tokenFingerprint,
  updateOwnEntry,
  TEAM_DIRECTORY_REFRESH_MS,
  __resetTeamDirectoryForTests,
} from '../../src/editor/collab/team-directory.js';
import { offerText, renderOffer, __resetTeamDirectoryUiForTests } from '../../src/editor/collab/team-directory-ui.js';
import { mergeTeamFile, parseTeamFile } from '../../src/editor/pairing/team-file.js';
import { settings } from '../../src/editor/settings.js';
import { __noticesForTests, __resetNoticesForTests } from '../../src/editor/status-notices.js';

const ME = 'cmk1.MEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEM';
const ANA = 'cmk1.ANAANAANAANAANAANAANAANAANAANAANAANAANAANA';
const BEN = 'cmk1.BENBENBENBENBENBENBENBENBENBENBENBENBENBEN';
const CAL = 'cmk1.CALCALCALCALCALCALCALCALCALCALCALCALCALCAL';
const KEY_A = 'A'.repeat(42) + 'A';
const KEY_B = 'B'.repeat(42) + 'A';
const BASE = 'https://relay.example/relay';
const TOKEN = 'team-token';

const DOC = {
  v: 1,
  name: 'Lincoln HS Debate',
  people: [
    { code: ANA, name: 'Ana Lopez', self: true },
    { code: BEN, name: 'Ben Wu' },
  ],
  groups: [{ label: 'Varsity', members: [ANA, BEN] }],
  revision: 17,
  updatedAt: 1792700000000,
};

// ── A fake relay ──────────────────────────────────────────────────────

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeRelay(opts: {
  discovery?: () => Response;
  directory?: () => Record<string, unknown>;
  teamKeyAnswer?: (key: string) => Response;
  /** PUT /me answers 409 "open card sharing first" this many times. */
  meRefusals?: number;
} = {}) {
  let refusals = opts.meRefusals ?? 0;
  const sent: Sent[] = [];
  let dir: Record<string, unknown> = structuredClone(opts.directory?.() ?? DOC);
  const client = new RoomsClient({
    baseUrl: () => BASE,
    token: () => TOKEN,
    fetchImpl: async (input, init) => {
      const path = String(input).slice(BASE.length);
      const method = init?.method ?? 'GET';
      const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      sent.push({ method, path, headers, body });
      if (path === '/ext/team-directory/v1') return opts.discovery?.() ?? json({ v: 1, maxPeople: 200, maxGroups: 50 });
      if (path === '/team-directory' && method === 'GET') {
        if (headers['If-None-Match'] === `"${dir['revision']}"`) return new Response(null, { status: 304 });
        return json(dir);
      }
      if (path === '/team-directory/me' && method === 'PUT') {
        if (refusals > 0) {
          refusals--;
          return json({ detail: 'open card sharing first: this install has not checked its mailbox yet' }, 409);
        }
        const b = body as { code: string; name: string };
        const people = (dir['people'] as Array<Record<string, unknown>>).filter((p) => p['code'] !== b.code);
        dir = { ...dir, people: [...people, { code: b.code, name: b.name, self: true }], revision: Number(dir['revision']) + 1 };
        return json({ revision: dir['revision'] });
      }
      if (path.startsWith('/team-directory/me?') && method === 'DELETE') return new Response(null, { status: 204 });
      if (path === '/team-directory/team-key' && method === 'PUT') {
        const k = (body as { teamKey: string }).teamKey;
        if (opts.teamKeyAnswer) return opts.teamKeyAnswer(k);
        if (dir['teamKey']) return json({ teamKey: dir['teamKey'] }, 409);
        dir = { ...dir, teamKey: k, revision: Number(dir['revision']) + 1 };
        return new Response(null, { status: 201 });
      }
      return json({ detail: 'not found' }, 404);
    },
  });
  return {
    client,
    sent,
    ctx: { client, baseUrl: BASE, token: TOKEN },
    edit(patch: Record<string, unknown>) {
      dir = { ...dir, ...patch, revision: Number(dir['revision']) + 1 };
    },
    paths: () => sent.map((s) => `${s.method} ${s.path}`),
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const key = directoryKey(BASE, TOKEN);
let clock = 1_000_000;
/** A refresh an hour after the last one (past the throttle). */
const later = () => (clock += TEAM_DIRECTORY_REFRESH_MS + 1);

beforeEach(() => {
  __resetTeamDirectoryForTests();
  __resetTeamDirectoryUiForTests();
  __resetNoticesForTests();
  toasts.length = 0;
  prompt.asked.length = 0;
  prompt.answer = null;
  clock = 1_000_000;
  settings.set('pairingRelayUrl', BASE);
  settings.set('pairingRelayToken', TOKEN);
  settings.set('pairingEnabled', true);
  settings.set('pairingOwnCode', ME);
  settings.set('pairingDisplayName', 'Sam');
  settings.set('pairingPartners', []);
  settings.set('pairingGroups', []);
  settings.set('teamSessionsKey', '');
  settings.set('teamDirectoryRelays', []);
});

// ── parsing ───────────────────────────────────────────────────────────

describe('parse', () => {
  it('reads the spec example', () => {
    const d = parseTeamDirectory({ ...DOC, teamKey: KEY_A })!;
    expect(d.name).toBe('Lincoln HS Debate');
    expect(d.people).toEqual([
      { code: ANA, name: 'Ana Lopez', self: true },
      { code: BEN, name: 'Ben Wu', self: false },
    ]);
    expect(d.groups).toEqual([{ label: 'Varsity', memberCodes: [ANA, BEN] }]);
    expect(d.teamKey).toBe(KEY_A);
    expect(d.revision).toBe(17);
  });

  it('drops malformed entries and unknown members; caps names at 60', () => {
    const d = parseTeamDirectory({
      v: 1,
      name: 'T',
      people: [{ code: ` ${ANA} `, name: 'x'.repeat(100) }, { name: 'no code' }, null, { code: ANA, name: 'dup' }],
      groups: [{ label: 'A', members: [ANA, CAL, 7] }, { label: '', members: [ANA] }, 'junk'],
      teamKey: 'not-a-key',
      revision: 'x',
    })!;
    expect(d.people).toHaveLength(1);
    expect(d.people[0]!.code).toBe(ANA);
    expect(d.people[0]!.name).toHaveLength(60);
    expect(d.groups).toEqual([{ label: 'A', memberCodes: [ANA] }]);
    expect(d.teamKey).toBeUndefined();
    expect(d.revision).toBe(0);
  });

  it('is null for anything that is not a v1 directory', () => {
    expect(parseTeamDirectory(null)).toBeNull();
    expect(parseTeamDirectory([])).toBeNull();
    expect(parseTeamDirectory({ ...DOC, v: 2 })).toBeNull();
    expect(parseTeamDirectory('<html>')).toBeNull();
  });

  it('reads the discovery document', () => {
    expect(parseTeamDirectorySupport({ v: 1, maxPeople: 200, maxGroups: 50 })).toEqual({ v: 1, maxPeople: 200, maxGroups: 50 });
    expect(parseTeamDirectorySupport({ v: 1 })).toEqual({ v: 1, maxPeople: 200, maxGroups: 50 });
    expect(parseTeamDirectorySupport({ v: 2 })).toBeNull();
    expect(parseTeamDirectorySupport(null)).toBeNull();
  });

  it('stores only a fingerprint of the token', () => {
    expect(directoryKey(BASE + '/', TOKEN)).toBe(`${BASE}#${tokenFingerprint(TOKEN)}`);
    expect(directoryKey(BASE, TOKEN)).not.toContain(TOKEN);
    expect(directoryKey(BASE, 'other')).not.toBe(directoryKey(BASE, TOKEN));
  });
});

// ── merge equivalence ─────────────────────────────────────────────────

describe('merge = team file import', () => {
  const local = {
    ownCode: ME,
    partners: [{ code: ANA, name: 'Ana (my name for her)' }],
    groups: [{ id: 'grp-1', label: 'varsity', memberCodes: [ANA] }],
  };
  const dirDoc = {
    ...DOC,
    people: [...DOC.people, { code: ME, name: 'Sam' }, { code: CAL, name: 'Cal' }],
    groups: [
      { label: 'Varsity', members: [ANA, BEN, ME] },
      { label: 'Novice', members: [CAL] },
    ],
  };
  const fileJson = {
    kind: 'cardmirror-team',
    version: 1,
    name: dirDoc.name,
    people: dirDoc.people.map((p) => ({ name: p.name, code: p.code })),
    groups: [
      { label: 'Varsity', members: ['Ana Lopez', 'Ben Wu', 'Sam'] },
      { label: 'Novice', members: ['Cal'] },
    ],
  };
  const strip = (r: ReturnType<typeof mergeTeamFile>) => ({
    ...r,
    groups: r.groups.map((g) => ({ label: g.label, memberCodes: g.memberCodes })),
  });

  it('merges exactly like importing the equivalent .cmteam', () => {
    const viaDir = mergeTeamDirectory({ directory: parseTeamDirectory(dirDoc)!, ...local });
    const viaFile = mergeTeamFile({ file: parseTeamFile(fileJson)!, ...local });
    expect(strip(viaDir)).toEqual(strip(viaFile));
    // The rules themselves: existing name kept, own code skipped, group
    // matched by name (case-insensitive) gains members, new group added.
    expect(viaDir.partners).toEqual([
      { code: ANA, name: 'Ana (my name for her)' },
      { code: BEN, name: 'Ben Wu' },
      { code: CAL, name: 'Cal' },
    ]);
    expect(strip(viaDir).groups).toEqual([
      { label: 'varsity', memberCodes: [ANA, BEN] },
      { label: 'Novice', memberCodes: [CAL] },
    ]);
    expect(viaDir.addedPeople).toBe(2);
  });

  it('counts missing people without your own code or known contacts', () => {
    const d = parseTeamDirectory(dirDoc)!;
    expect(missingPeople(d, ME, local.partners)).toBe(2);
    expect(missingPeople(d, ME, [...local.partners, { code: BEN, name: 'b' }, { code: CAL, name: 'c' }])).toBe(0);
  });
});

// ── the offer ─────────────────────────────────────────────────────────

describe('offer and Not now', () => {
  it('offers when people are missing; Not now hides it until the revision changes', async () => {
    const relay = fakeRelay();
    const seen: Array<string | null> = [];
    onTeamDirectoryOffer((o) => seen.push(o ? `${o.directory.revision}:${o.missing}` : null));
    await refreshTeamDirectory(relay.ctx, { now: clock });
    expect(currentOffer()?.missing).toBe(2);
    expect(offerText(currentOffer()!)).toBe('Your team (Lincoln HS Debate) is set up on this relay. Import it?');
    // Before Import nothing is sent but GETs.
    expect(relay.sent.every((s) => s.method === 'GET')).toBe(true);

    dismissOffer(key, 17);
    expect(currentOffer()).toBeNull();
    expect(directoryState(key).dismissedRevision).toBe(17);

    await refreshTeamDirectory(relay.ctx, { now: later() });
    expect(relay.sent.at(-1)!.headers['If-None-Match']).toBe('"17"');
    expect(currentOffer()).toBeNull();

    relay.edit({ people: [...DOC.people, { code: CAL, name: 'Cal' }] });
    await refreshTeamDirectory(relay.ctx, { now: later() });
    expect(currentOffer()?.directory.revision).toBe(18);
    expect(seen).toEqual(['17:2', null, '18:3']);
  });

  it('does not offer when nobody is missing and you are listed', async () => {
    settings.set('pairingPartners', [
      { code: ANA, name: 'Ana' },
      { code: BEN, name: 'Ben' },
    ]);
    await refreshTeamDirectory(fakeRelay({ directory: () => ({ ...DOC, people: [...DOC.people, { code: ME, name: 'Sam', self: true }] }) }).ctx, { now: clock });
    expect(currentOffer()).toBeNull();
  });

  it('offers "add yourself" when nobody is missing but you are not listed (a new team)', async () => {
    await refreshTeamDirectory(fakeRelay({ directory: () => ({ ...DOC, people: [], groups: [] }) }).ctx, { now: clock });
    expect(currentOffer()).toMatchObject({ missing: 0, listed: false });
  });

  it('no "add yourself" offer without a valid send code', async () => {
    settings.set('pairingOwnCode', 'cmk1.short');
    await refreshTeamDirectory(fakeRelay({ directory: () => ({ ...DOC, people: [], groups: [] }) }).ctx, { now: clock });
    expect(currentOffer()).toBeNull();
  });

  it('shouldOffer: imported or dismissed at this revision never offers', () => {
    const d = parseTeamDirectory(DOC)!;
    expect(shouldOffer(d, { imported: false, dismissedRevision: -1 }, ME, [])).toBe(true);
    expect(shouldOffer(d, { imported: true, dismissedRevision: -1 }, ME, [])).toBe(false);
    expect(shouldOffer(d, { imported: false, dismissedRevision: 17 }, ME, [])).toBe(false);
    expect(shouldOffer(d, { imported: false, dismissedRevision: 16 }, ME, [])).toBe(true);
  });

  it('a null context (no custom relay / sharing off) takes the offer down', async () => {
    await refreshTeamDirectory(fakeRelay().ctx, { now: clock });
    expect(currentOffer()).not.toBeNull();
    await refreshTeamDirectory(null);
    expect(currentOffer()).toBeNull();
  });

  it('fetches at most hourly unless forced', async () => {
    const relay = fakeRelay();
    await refreshTeamDirectory(relay.ctx, { now: clock });
    const n = relay.sent.length;
    await refreshTeamDirectory(relay.ctx, { now: clock + 60_000 });
    expect(relay.sent.length).toBe(n);
    await refreshTeamDirectory(relay.ctx, { now: clock + 60_000, force: true });
    expect(relay.sent.length).toBe(n + 1);
  });
});

// ── unsupported ───────────────────────────────────────────────────────

describe('discovery', () => {
  for (const [label, answer] of [
    ['404', () => json({ detail: 'not found' }, 404)],
    ['500', () => json({ detail: 'boom' }, 500)],
    ['non-v1', () => json({ v: 2 })],
    ['HTML', () => new Response('<!doctype html><p>hi', { status: 200 })],
  ] as const) {
    it(`${label} → nothing new, and the directory is never asked for`, async () => {
      const relay = fakeRelay({ discovery: answer });
      expect(await refreshTeamDirectory(relay.ctx, { now: clock })).toBeNull();
      expect(currentOffer()).toBeNull();
      expect(relay.paths()).toEqual(['GET /ext/team-directory/v1']);
      expect(settings.get('teamDirectoryRelays')).toEqual([]);
      // Cached for the run: one discovery call per relay.
      await refreshTeamDirectory(relay.ctx, { now: later() });
      expect(relay.paths()).toEqual(['GET /ext/team-directory/v1']);
    });
  }
});

// ── import ────────────────────────────────────────────────────────────

describe('import', () => {
  it('registers only our own code and name, then merges', async () => {
    const relay = fakeRelay();
    settings.set('pairingPartners', [{ code: ANA, name: 'Ana (mine)' }]);
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    const out = await importTeamDirectory(relay.ctx, dir, '  Sam Lee  ');
    expect(out).toEqual({ ok: true, addedPeople: 1, addedGroups: 1 });
    const put = relay.sent.find((s) => s.method === 'PUT')!;
    expect(put.path).toBe('/team-directory/me');
    expect(put.body).toEqual({ code: ME, name: 'Sam Lee' });
    expect(settings.get('pairingDisplayName')).toBe('Sam Lee');
    expect(settings.get('pairingPartners')).toEqual([
      { code: ANA, name: 'Ana (mine)' },
      { code: BEN, name: 'Ben Wu' },
    ]);
    expect(settings.get('pairingGroups').map((g) => [g.label, g.memberCodes])).toEqual([['Varsity', [ANA, BEN]]]);
    expect(directoryState(key).imported).toBe(true);
    expect(currentOffer()).toBeNull();
  });

  it('a failed registration merges nothing and keeps the offer', async () => {
    const relay = fakeRelay();
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    const broken = { ...relay.ctx, client: new RoomsClient({ baseUrl: () => BASE, token: () => TOKEN, fetchImpl: async () => json({ detail: 'no' }, 500) }) };
    expect(await importTeamDirectory(broken, dir, 'Sam')).toEqual({ ok: false, reason: 'failed' });
    expect(settings.get('pairingPartners')).toEqual([]);
    expect(directoryState(key).imported).toBe(false);
    expect(currentOffer()).not.toBeNull();
  });

  it('the relay\'s "open card sharing first" 409: connects the mailbox and retries once', async () => {
    const relay = fakeRelay({ meRefusals: 1 });
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    let polled = 0;
    const out = await importTeamDirectory(relay.ctx, dir, 'Sam', { connectMailbox: async () => void polled++, delayMs: 0 });
    expect(out.ok).toBe(true);
    expect(polled).toBe(1);
    expect(relay.sent.filter((s) => s.method === 'PUT' && s.path === '/team-directory/me')).toHaveLength(2);
  });

  it('still 409 after the retry → not connected, nothing merged', async () => {
    const relay = fakeRelay({ meRefusals: 2 });
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    const out = await importTeamDirectory(relay.ctx, dir, 'Sam', { delayMs: 0 });
    expect(out).toEqual({ ok: false, reason: 'not-connected' });
    expect(settings.get('pairingPartners')).toEqual([]);
    expect(directoryState(key).imported).toBe(false);
  });

  it('DELETE /team-directory/me always names the code', async () => {
    const relay = fakeRelay();
    await relay.client.deleteTeamDirectoryMe(ME);
    expect(relay.paths()).toEqual([`DELETE /team-directory/me?code=${encodeURIComponent(ME)}`]);
  });

  it('needs a send code', async () => {
    const relay = fakeRelay();
    settings.set('pairingOwnCode', 'cmk1.short');
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    expect(await importTeamDirectory(relay.ctx, dir, 'Sam')).toEqual({ ok: false, reason: 'no-code' });
    expect(relay.sent.some((s) => s.method === 'PUT')).toBe(false);
  });

  it('then keeps in sync: If-None-Match, 304 = nothing, new people merge quietly with a toast', async () => {
    const relay = fakeRelay();
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    await importTeamDirectory(relay.ctx, dir, 'Sam');
    toasts.length = 0;
    // First re-fetch: the directory changed (our own entry) → whole body,
    // nothing new to add, no toast.
    await refreshTeamDirectory(relay.ctx, { now: later() });
    expect(relay.sent.at(-1)!.headers['If-None-Match']).toBe('"17"');
    expect(toasts).toEqual([]);
    await refreshTeamDirectory(relay.ctx, { now: later() });
    expect(relay.sent.at(-1)!.headers['If-None-Match']).toBe('"18"');
    expect(toasts).toEqual([]);

    relay.edit({
      people: [...DOC.people, { code: ME, name: 'Sam', self: true }, { code: CAL, name: 'Cal' }],
      groups: [{ label: 'Varsity', members: [ANA, BEN, CAL] }],
    });
    await refreshTeamDirectory(relay.ctx, { now: later() });
    expect(toasts).toEqual(['Added 1 teammate from your relay.']);
    expect(settings.get('pairingPartners').map((p) => p.code)).toEqual([ANA, BEN, CAL]);
    expect(settings.get('pairingGroups')[0]!.memberCodes).toEqual([ANA, BEN, CAL]);
    expect(currentOffer()).toBeNull();
  });

  it('re-registers when the display name changes (once per change, only once imported)', async () => {
    const relay = fakeRelay();
    expect(await updateOwnEntry(relay.ctx)).toBe(false); // not imported
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    await importTeamDirectory(relay.ctx, dir, 'Sam');
    expect(await updateOwnEntry(relay.ctx)).toBe(false); // unchanged
    settings.set('pairingDisplayName', 'Samantha');
    expect(await updateOwnEntry(relay.ctx)).toBe(true);
    expect(relay.sent.at(-1)!.body).toEqual({ code: ME, name: 'Samantha' });
    expect(await updateOwnEntry(relay.ctx)).toBe(false);
  });
});

// ── team key ──────────────────────────────────────────────────────────

describe('team key', () => {
  async function imported(relay: ReturnType<typeof fakeRelay>): Promise<void> {
    const dir = (await refreshTeamDirectory(relay.ctx, { now: clock }))!;
    await importTeamDirectory(relay.ctx, dir, 'Sam');
  }
  const conflictNotices = () => __noticesForTests().filter((n) => n.key === 'team-key-conflict');

  it('directory has one, machine has none → adopted', async () => {
    const relay = fakeRelay({ directory: () => ({ ...DOC, teamKey: KEY_A }) });
    await imported(relay);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    expect(relay.sent.some((s) => s.path === '/team-directory/team-key')).toBe(false);
  });

  it('directory has none, machine has one → PUT', async () => {
    settings.set('teamSessionsKey', KEY_A);
    const relay = fakeRelay();
    await imported(relay);
    const put = relay.sent.find((s) => s.path === '/team-directory/team-key')!;
    expect(put.body).toEqual({ teamKey: KEY_A });
    expect(directoryState(key).hasKey).toBe(true);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    expect(conflictNotices()).toHaveLength(0);
  });

  it('409 with another key → ours kept, the team file mismatch notice', async () => {
    settings.set('teamSessionsKey', KEY_A);
    const relay = fakeRelay({ teamKeyAnswer: () => json({ teamKey: KEY_B }, 409) });
    await imported(relay);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    expect(conflictNotices()).toHaveLength(1);
  });

  it('409 with the same key → nothing to say', async () => {
    settings.set('teamSessionsKey', KEY_A);
    const relay = fakeRelay({ teamKeyAnswer: () => json({ teamKey: KEY_A }, 409) });
    await imported(relay);
    expect(conflictNotices()).toHaveLength(0);
  });

  it('a different key in the directory never replaces ours', async () => {
    settings.set('teamSessionsKey', KEY_A);
    const relay = fakeRelay({ directory: () => ({ ...DOC, teamKey: KEY_B }) });
    await imported(relay);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    expect(conflictNotices()).toHaveLength(1);
    expect(relay.sent.some((s) => s.path === '/team-directory/team-key')).toBe(false);
  });

  it('nothing about the key is sent before Import', async () => {
    settings.set('teamSessionsKey', KEY_A);
    const relay = fakeRelay();
    await refreshTeamDirectory(relay.ctx, { now: clock });
    expect(relay.sent.some((s) => s.method !== 'GET')).toBe(false);
  });
});

// ── the status-bar offer ──────────────────────────────────────────────

describe('offer UI', () => {
  const segment = () => document.getElementById('team-directory-offer')!;
  const button = (label: string) =>
    [...segment().querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('shows the sentence with Import / Not now; Not now dismisses for this revision', async () => {
    const relay = fakeRelay();
    relayRef.client = relay.client;
    onTeamDirectoryOffer(renderOffer);
    await refreshTeamDirectory(relay.ctx, { now: clock });
    expect(segment().hidden).toBe(false);
    expect(segment().textContent).toContain('Your team (Lincoln HS Debate) is set up on this relay. Import it?');
    button('Not now').click();
    await settle();
    expect(segment().hidden).toBe(true);
    expect(directoryState(key).dismissedRevision).toBe(17);
  });

  it('Import asks for the name (pre-filled), saves it, registers and merges', async () => {
    const relay = fakeRelay();
    relayRef.client = relay.client;
    onTeamDirectoryOffer(renderOffer);
    await refreshTeamDirectory(relay.ctx, { now: clock });
    prompt.answer = 'Sam Lee';
    button('Import').click();
    await vi.waitFor(() => expect(directoryState(key).imported).toBe(true));
    expect(prompt.asked).toHaveLength(1);
    expect(prompt.asked[0]!.message).toBe('Your display name');
    expect(prompt.asked[0]!.initial).toBe('Sam');
    expect(settings.get('pairingDisplayName')).toBe('Sam Lee');
    expect(settings.get('pairingPartners')).toHaveLength(2);
    expect(toasts.at(-1)).toBe('Imported “Lincoln HS Debate”: added 2 teammates.');
    expect(segment().hidden).toBe(true);
  });

  it('cancelling the name prompt imports nothing and keeps the offer', async () => {
    const relay = fakeRelay();
    relayRef.client = relay.client;
    onTeamDirectoryOffer(renderOffer);
    await refreshTeamDirectory(relay.ctx, { now: clock });
    prompt.answer = null;
    button('Import').click();
    await vi.waitFor(() => expect(prompt.asked).toHaveLength(1));
    await settle();
    expect(relay.sent.some((s) => s.method === 'PUT')).toBe(false);
    expect(segment().hidden).toBe(false);
  });
});

