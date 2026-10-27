// @vitest-environment jsdom
/**
 * "+ Add a relay…" under Saved relays: reading an invite link or an address
 * + token through main's parser (https only), checking THAT relay with THAT
 * token only (the relay in use's token is never sent to it), and saving
 * without switching: a new relay is saved as never used with no team key,
 * a rotated token at a saved per-team address updates that relay, and the
 * relay in use is never switched by Save.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRelayJoinLink } from '../../apps/desktop/src/relay-join-link.js';

const host = vi.hoisted(() => ({
  checks: [] as Array<{ relayUrl: string; relayToken: string }>,
  check: { custom: true, ok: true, status: 200 },
}));
vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      relayJoinParse: async (raw: string) => parseRelayJoinLink(raw),
      pairingRelayCheck: async (p: { relayUrl: string; relayToken: string }) => {
        host.checks.push(p);
        return host.check;
      },
      pairingPollNow: async () => {},
    }),
  };
});
const toasts = vi.hoisted(() => [] as string[]);
vi.mock('../../src/editor/toast.js', () => ({ showToast: (m: string) => toasts.push(m) }));

import {
  checkNewRelay,
  checkSummary,
  readAddRelayInput,
  ADD_RELAY_BAD_INVITE,
  ADD_RELAY_FOREIGN_TOKEN,
  ADD_RELAY_NOT_HTTPS,
  ADD_RELAY_NOT_INVITE,
  ADD_RELAY_UNREACHABLE,
  type ParseRelayLink,
} from '../../src/editor/collab/relay-add.js';
import { activeProfile, addRelayPlan, addSavedRelay, rememberConnectedRelay, switchRelay } from '../../src/editor/collab/relay-profiles.js';
import { buildSavedRelaysSection, afterSwitchRefresh, __resetRelayProfilesUiForTests } from '../../src/editor/collab/relay-profiles-ui.js';
import { openAddRelayDialog, __resetAddRelayDialogForTests } from '../../src/editor/collab/relay-add-ui.js';
import { directoryKey } from '../../src/editor/collab/team-directory.js';
import { settings } from '../../src/editor/settings.js';

const parse: ParseRelayLink = async (raw) => parseRelayJoinLink(raw);
const ACTIVE = { url: 'https://hs.relay.example/relay', token: 'active-secret-token' };
const NEW = { relayUrl: 'https://college.example/r/squad', token: 'college-token' };
const KEY_A = 'A'.repeat(42) + 'A';
const invite = (u: string, t: string) => `https://extinction.gg/relay/join#u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

function useRelay(r: { url: string; token: string }, key = ''): void {
  settings.setMany({ pairingRelayUrl: r.url, pairingRelayToken: r.token, teamSessionsKey: key });
}

/** A relay that answers info + team list with `name` and `people` people. */
function fakeRelay(name: string, people: number) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    const body = u.endsWith('/ext/relay-info/v1')
      ? { v: 1, operator: { name: 'xtgg relay' } }
      : {
          v: 1,
          name,
          people: Array.from({ length: people }, (_, i) => ({ code: `cm${i}abcdefgh`, name: `P${i}` })),
          groups: [],
          revision: 1,
        };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

beforeEach(() => {
  __resetRelayProfilesUiForTests();
  __resetAddRelayDialogForTests();
  toasts.length = 0;
  host.checks.length = 0;
  host.check = { custom: true, ok: true, status: 200 };
  afterSwitchRefresh.run = () => {};
  settings.set('relayProfiles', []);
  settings.set('relayBuiltinTeamKey', '');
  settings.set('teamDirectoryRelays', []);
  settings.set('pairingEnabled', true);
  useRelay(ACTIVE, KEY_A);
  rememberConnectedRelay({ now: 1000 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('reading the invite link or address + token', () => {
  it('reads both invite forms and the separate fields into the same link', async () => {
    const want = { ok: true, link: NEW };
    expect(await readAddRelayInput({ invite: invite(NEW.relayUrl, NEW.token) }, parse)).toEqual(want);
    expect(
      await readAddRelayInput(
        { invite: `xtgg-relay://join?url=${encodeURIComponent(NEW.relayUrl)}&token=${NEW.token}` },
        parse,
      ),
    ).toEqual(want);
    expect(await readAddRelayInput({ url: ` ${NEW.relayUrl}/ `, token: ` ${NEW.token} ` }, parse)).toEqual(want);
    // No scheme typed: https.
    expect(await readAddRelayInput({ url: 'college.example/r/squad', token: NEW.token }, parse)).toEqual(want);
  });

  it('rejects http, non-invites, broken links and bad tokens', async () => {
    expect(await readAddRelayInput({ url: 'http://college.example/r/squad', token: 't' }, parse)).toEqual({
      ok: false,
      message: ADD_RELAY_NOT_HTTPS,
    });
    expect(await readAddRelayInput({ invite: invite('http://college.example/r/squad', 't') }, parse)).toEqual({
      ok: false,
      message: ADD_RELAY_NOT_HTTPS,
    });
    expect(await readAddRelayInput({ invite: 'cmshare1.room.key' }, parse)).toEqual({ ok: false, message: ADD_RELAY_NOT_INVITE });
    expect((await readAddRelayInput({ invite: 'https://extinction.gg/relay/join#u=https%3A%2F%2Fr.example' }, parse)).ok).toBe(false);
    expect(await readAddRelayInput({ invite: invite('https://u:p@r.example/x', 't') }, parse)).toEqual({
      ok: false,
      message: ADD_RELAY_BAD_INVITE,
    });
    expect((await readAddRelayInput({ url: NEW.relayUrl, token: 'has space' }, parse)).ok).toBe(false);
    expect((await readAddRelayInput({ url: NEW.relayUrl, token: '' }, parse)).ok).toBe(false);
  });
});

describe('checking the new relay', () => {
  it('asks that relay with its own token only, and names it', async () => {
    const fetchImpl = fakeRelay('Collegiate', 3);
    const r = await checkNewRelay(NEW, {
      relayCheck: async (p) => {
        host.checks.push(p);
        return host.check;
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.ok && checkSummary(r)).toBe('✓ Collegiate — 3 teammates');
    expect(host.checks).toEqual([{ relayUrl: NEW.relayUrl, relayToken: NEW.token }]);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/college\.example\/r\/squad\//);
      const headers = JSON.stringify(init?.headers ?? {});
      expect(headers).toContain(NEW.token);
      expect(headers).not.toContain(ACTIVE.token);
    }
  });

  it('never sends a token saved for another host', async () => {
    const relayCheck = vi.fn();
    const fetchImpl = vi.fn();
    const r = await checkNewRelay({ relayUrl: 'https://evil.example/relay', token: ACTIVE.token }, {
      relayCheck,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual({ ok: false, message: ADD_RELAY_FOREIGN_TOKEN });
    expect(relayCheck).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('says the relay’s own refusal, or that it couldn’t be reached', async () => {
    const refusing = vi.fn(async () =>
      new Response(JSON.stringify({ detail: 'This team’s plan has ended. Renew at the manage page.' }), { status: 401 }),
    );
    const refused = await checkNewRelay(NEW, {
      relayCheck: async () => ({ custom: true, ok: false, status: 401 }),
      fetchImpl: refusing as unknown as typeof fetch,
    });
    expect(refused).toEqual({ ok: false, message: 'The relay said: This team’s plan has ended. Renew at the manage page.' });
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    });
    const down = await checkNewRelay(NEW, {
      relayCheck: async () => ({ custom: true, ok: false, status: 0 }),
      fetchImpl: offline as unknown as typeof fetch,
    });
    expect(down).toEqual({ ok: false, message: ADD_RELAY_UNREACHABLE });
  });
});

describe('saving without switching', () => {
  it('a new relay is saved, never used, with no team key; the relay in use stays', () => {
    expect(addRelayPlan(NEW.relayUrl, NEW.token)).toEqual({ kind: 'new' });
    const r = addSavedRelay(NEW.relayUrl, NEW.token);
    expect(r.kind).toBe('added');
    const list = settings.get('relayProfiles');
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ url: NEW.relayUrl, token: NEW.token, teamKey: '', lastUsed: 0, label: 'squad', labelCustom: false });
    expect(settings.get('pairingRelayUrl')).toBe(ACTIVE.url);
    expect(settings.get('pairingRelayToken')).toBe(ACTIVE.token);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    expect(activeProfile()?.url).toBe(ACTIVE.url);
  });

  it('a new token at a saved per-team address updates that relay, keeping its key and team list state', async () => {
    addSavedRelay(NEW.relayUrl, NEW.token);
    const id = settings.get('relayProfiles')[1]!.id;
    // Used once: it has a key and a team list state now.
    await switchRelay(id, { sessionLive: () => false, confirmLeave: async () => true, leaveSessions: async () => true });
    settings.set('teamSessionsKey', 'K'.repeat(43));
    settings.set('teamDirectoryRelays', [{ key: directoryKey(NEW.relayUrl, NEW.token), imported: true, dismissedRevision: -1, revision: -1, hasKey: false }]);
    await switchRelay(settings.get('relayProfiles')[0]!.id, { sessionLive: () => false, confirmLeave: async () => true, leaveSessions: async () => true });

    expect(addRelayPlan(NEW.relayUrl, 'rotated-token').kind).toBe('update');
    const r = addSavedRelay(NEW.relayUrl, 'rotated-token');
    expect(r).toMatchObject({ kind: 'updated', current: false });
    const list = settings.get('relayProfiles');
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.id === id)).toMatchObject({ token: 'rotated-token', teamKey: 'K'.repeat(43) });
    expect(settings.get('teamDirectoryRelays').map((d) => d.key)).toEqual([directoryKey(NEW.relayUrl, 'rotated-token')]);
    expect(settings.get('pairingRelayToken')).toBe(ACTIVE.token);
  });

  it('the same token again is “already saved”; a shared address with another token is another relay', () => {
    addSavedRelay(NEW.relayUrl, NEW.token);
    expect(addSavedRelay(NEW.relayUrl, NEW.token).kind).toBe('exists');
    expect(addRelayPlan(ACTIVE.url, ACTIVE.token).kind).toBe('current');
    expect(addRelayPlan(ACTIVE.url, 'other-team-token').kind).toBe('new');
    expect(settings.get('relayProfiles')).toHaveLength(2);
  });
});

describe('the Saved relays list and the dialog', () => {
  it('shows a never-used relay as saved, not used yet, and the Add button below Built-in relay', () => {
    addSavedRelay(NEW.relayUrl, NEW.token);
    const el = buildSavedRelaysSection(() => {});
    const details = [...el.querySelectorAll('.pmd-saved-relay-detail')].map((d) => d.textContent);
    expect(details).toEqual(['hs.relay.example/relay · in use', 'college.example/r/squad · saved, not used yet', 'the default relay (no custom URL)']);
    expect(el.lastElementChild?.textContent).toBe('+ Add a relay…');
    expect(el.textContent).toContain('+ Add a relay… saves another relay from its invite link without switching to it.');
  });

  it('paste checks right away; Save adds it without switching', async () => {
    vi.stubGlobal('fetch', fakeRelay('Collegiate', 3));
    const done = openAddRelayDialog();
    const input = document.querySelector<HTMLInputElement>('.pmd-add-relay-dialog input')!;
    expect(document.activeElement).toBe(input);
    input.value = invite(NEW.relayUrl, NEW.token);
    input.dispatchEvent(new Event('paste'));
    input.dispatchEvent(new Event('input'));
    for (let i = 0; i < 20 && !document.querySelector('.pmd-add-relay-status')?.textContent?.startsWith('✓'); i++) await flush();
    expect(document.querySelector('.pmd-add-relay-status')!.textContent).toContain('✓ Collegiate — 3 teammates');
    expect(host.checks).toEqual([{ relayUrl: NEW.relayUrl, relayToken: NEW.token }]);
    const save = [...document.querySelectorAll<HTMLButtonElement>('.pmd-add-relay-dialog button')].find((b) => b.textContent === 'Save')!;
    expect(save.hidden).toBe(false);
    save.click();
    await done;
    expect(settings.get('relayProfiles').map((p) => p.url)).toEqual([ACTIVE.url, NEW.relayUrl]);
    expect(settings.get('pairingRelayUrl')).toBe(ACTIVE.url);
    expect(toasts[0]).toMatch(/^Saved squad\./);
  });
});
