// @vitest-environment jsdom
/**
 * Relay invite links (BCai's build): one Connect dialog, URL + token written
 * as ONE settings change (main must never see the new URL with the old
 * token — it would send the old relay's token to the new relay's
 * mailbox-proof endpoint), a name field when there's no display name, a
 * bad link that says so, and pasted links in both forms.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  handler: null as null | ((p: { relayUrl: string; token: string } | { error: 'invalid' | 'lite' }) => void),
  parse: vi.fn(),
}));
vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      onRelayJoin: (h: typeof host.handler) => {
        host.handler = h;
        return () => {};
      },
      relayJoinParse: host.parse,
    }),
  };
});
vi.mock('../../src/editor/collab/collab-gate.js', () => ({ collabEnabled: () => true }));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock('../../src/editor/toast.js', () => ({ showToast: (m: string) => toasts.push(m) }));
const confirm = vi.hoisted(() => ({ answer: true, name: '', opts: null as null | Record<string, unknown> }));
vi.mock('../../src/editor/confirm-dialog.js', () => ({
  showConfirm: async (opts: { field?: { onInput: (v: string) => void } } & Record<string, unknown>) => {
    confirm.opts = opts;
    if (confirm.name) opts.field?.onInput(confirm.name);
    return confirm.answer;
  },
}));
vi.mock('../../src/editor/collab/team-directory-ui.js', () => ({ importTeamAfterConnect: async () => {} }));

import { connectDialogText, describeRelay, initRelayJoin, joinRelayFromText, BAD_INVITE_LINK } from '../../src/editor/pairing/relay-join.js';
import { readRelayInviteText } from '../../src/editor/pairing/relay-invite-text.js';
import { settings } from '../../src/editor/settings.js';
import { adoptRelay, switchRelay, rememberConnectedRelay } from '../../src/editor/collab/relay-profiles.js';

const OLD = { url: 'https://old.example/relay', token: 'old-token-1234' };
const NEW = { relayUrl: 'https://new.example/relay', token: 'new-token-5678' };

/** Every settings snapshot a subscriber sees, as url|token pairs. */
function watchPairs(): { pairs: string[]; stop: () => void } {
  const pairs: string[] = [];
  const stop = settings.subscribe((st) => pairs.push(`${st.pairingRelayUrl}|${st.pairingRelayToken}`));
  return { pairs, stop };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  toasts.length = 0;
  confirm.answer = true;
  confirm.name = '';
  confirm.opts = null;
  host.parse.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  settings.set('relayProfiles', []);
  settings.set('teamSessionsKey', '');
  settings.set('pairingDisplayName', '');
  settings.setMany({ pairingRelayUrl: OLD.url, pairingRelayToken: OLD.token, pairingEnabled: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('settings.setMany', () => {
  it('writes every key before notifying, and notifies once', () => {
    const w = watchPairs();
    settings.setMany({ pairingRelayUrl: 'https://a.example', pairingRelayToken: 'tok-a' });
    w.stop();
    expect(w.pairs).toEqual(['https://a.example|tok-a']);
  });
  it('an unchanged patch notifies nobody', () => {
    const w = watchPairs();
    settings.setMany({ pairingRelayUrl: OLD.url, pairingRelayToken: OLD.token });
    w.stop();
    expect(w.pairs).toEqual([]);
  });
});

describe('relay switches never show a mixed URL/token pair', () => {
  const mixed = (pairs: string[]): string[] =>
    pairs.filter((p) => p === `${NEW.relayUrl}|${OLD.token}` || p === `${OLD.url}|${NEW.token}`);

  it('the invite link Connect', async () => {
    initRelayJoin();
    const w = watchPairs();
    host.handler!(NEW);
    await vi.waitFor(() => expect(settings.get('pairingRelayUrl')).toBe(NEW.relayUrl));
    w.stop();
    expect(settings.get('pairingRelayToken')).toBe(NEW.token);
    expect(mixed(w.pairs)).toEqual([]);
  });

  it('adoptRelay (team file) and switchRelay (saved relays)', async () => {
    const w = watchPairs();
    adoptRelay(NEW.relayUrl, NEW.token);
    const saved = rememberConnectedRelay()!;
    adoptRelay(OLD.url, OLD.token);
    await switchRelay(saved.id, { sessionLive: () => false, confirmLeave: async () => true, leaveSessions: async () => true });
    w.stop();
    expect(settings.get('pairingRelayUrl')).toBe(NEW.relayUrl);
    expect(mixed(w.pairs)).toEqual([]);
  });
});

describe('the Connect dialog', () => {
  it('names the team and relay, not the token, and asks for a name when there is none', async () => {
    initRelayJoin();
    confirm.name = 'Ana Lopez';
    host.handler!(NEW);
    await vi.waitFor(() => expect(settings.get('pairingDisplayName')).toBe('Ana Lopez'));
    expect(String(confirm.opts!['message'])).toContain('new.example');
    expect(String(confirm.opts!['message'])).not.toContain('new-toke');
    expect(confirm.opts!['unsolicited']).toBe(true);
    expect(confirm.opts!['field']).toBeTruthy();
  });

  it('no name field when the name is already set', async () => {
    settings.set('pairingDisplayName', 'Ben');
    initRelayJoin();
    host.handler!(NEW);
    await vi.waitFor(() => expect(confirm.opts).not.toBeNull());
    expect(confirm.opts!['field']).toBeUndefined();
  });

  it('Cancel changes nothing', async () => {
    confirm.answer = false;
    initRelayJoin();
    host.handler!(NEW);
    await vi.waitFor(() => expect(confirm.opts).not.toBeNull());
    await flush();
    expect(settings.get('pairingRelayUrl')).toBe(OLD.url);
  });

  it('text: team + operator when the relay says, the host otherwise', () => {
    const ctx = { currentUrl: OLD.url, currentToken: OLD.token, enabled: false, ...NEW };
    const named = connectDialogText({ host: 'new.example', operator: 'xtgg relay', team: 'Lincoln Debate' }, ctx);
    expect(named.title).toBe('Join Lincoln Debate in CardMirror?');
    expect(named.message).toContain('Relay: xtgg relay (new.example)');
    expect(named.message).toContain('replaces the relay you use now (old.example)');
    expect(named.message).toContain('turns on card sharing');
    const bare = connectDialogText({ host: 'new.example', operator: '', team: '' }, ctx);
    expect(bare.title).toBe('Connect CardMirror to your team’s relay?');
    expect(bare.message).toContain('Relay: new.example');
    // Connect also lists you on the team's list: said, with your name.
    expect(bare.message).toContain('lists you on your team’s list under the name below');
    expect(connectDialogText({ host: 'new.example', operator: '', team: '' }, { ...ctx, name: 'Ana Lopez' }).message).toContain(
      'lists you on your team’s list as “Ana Lopez” with your send code',
    );
  });

  it('a link from another app opens unsolicited; a pasted one (Join box, sharing setup) does not', async () => {
    initRelayJoin();
    host.handler!(NEW);
    await vi.waitFor(() => expect(confirm.opts).not.toBeNull());
    expect(confirm.opts!['unsolicited']).toBe(true);
    await vi.waitFor(() => expect(settings.get('pairingRelayUrl')).toBe(NEW.relayUrl));
    confirm.opts = null;
    settings.setMany({ pairingRelayUrl: OLD.url, pairingRelayToken: OLD.token });
    host.parse.mockResolvedValue({ ok: true, link: NEW });
    await joinRelayFromText(`xtgg-relay://join?url=${encodeURIComponent(NEW.relayUrl)}&token=${NEW.token}`);
    expect(confirm.opts!['unsolicited']).toBe(false);
  });

  it('describeRelay reads the operator and the team name from the relay', async () => {
    const fake = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.endsWith('/ext/relay-info/v1')
        ? { v: 1, operator: { name: 'xtgg relay' } }
        : { v: 1, name: 'Lincoln Debate', people: [], groups: [], revision: 1 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const d = await describeRelay(NEW, 1000, fake as unknown as typeof fetch);
    expect(d).toEqual({ host: 'new.example', operator: 'xtgg relay', team: 'Lincoln Debate' });
    // Only the link's own token went to the link's relay.
    for (const call of fake.mock.calls) expect(String(call[0])).toMatch(/^https:\/\/new\.example\/relay\//);
  });
});

describe('bad and pasted links', () => {
  it('a link main rejected says so instead of doing nothing', () => {
    initRelayJoin();
    host.handler!({ error: 'invalid' });
    expect(toasts).toEqual([BAD_INVITE_LINK]);
  });

  it('reads both invite forms; anything else is not an invite', () => {
    expect(readRelayInviteText('https://extinction.gg/relay/join#u=https%3A%2F%2Fr.example%2Fx&t=abcdefgh12')).toEqual({
      kind: 'link',
      link: 'xtgg-relay://join?url=https%3A%2F%2Fr.example%2Fx&token=abcdefgh12',
    });
    expect(readRelayInviteText('  xtgg-relay://join?url=https%3A%2F%2Fr.example&token=t  ')).toEqual({
      kind: 'link',
      link: 'xtgg-relay://join?url=https%3A%2F%2Fr.example&token=t',
    });
    expect(readRelayInviteText('https://extinction.gg/relay/join#u=https%3A%2F%2Fr.example')).toEqual({ kind: 'broken' });
    expect(readRelayInviteText('cmshare1.room.key')).toEqual({ kind: 'none' });
    expect(readRelayInviteText('https://cardmirror.app/join#c=cmshare1.x')).toEqual({ kind: 'none' });
  });

  it('a pasted link goes through main’s parser, then the same Connect', async () => {
    host.parse.mockResolvedValue({ ok: true, link: NEW });
    const handled = await joinRelayFromText(`https://extinction.gg/relay/join#u=${encodeURIComponent(NEW.relayUrl)}&t=${NEW.token}`);
    expect(handled).toBe(true);
    expect(host.parse).toHaveBeenCalledWith(`xtgg-relay://join?url=${encodeURIComponent(NEW.relayUrl)}&token=${NEW.token}`);
    expect(settings.get('pairingRelayUrl')).toBe(NEW.relayUrl);
  });

  it('a pasted link main rejects, and a session code passes through', async () => {
    host.parse.mockResolvedValue({ ok: false, reason: 'relay url is not https' });
    expect(await joinRelayFromText('xtgg-relay://join?url=http%3A%2F%2Fx&token=t')).toBe(true);
    expect(toasts).toContain(BAD_INVITE_LINK);
    expect(await joinRelayFromText('cmshare2.abc.def')).toBe(false);
  });
});

describe('an invite link with a rotated token (1.15.46 review)', () => {
  const KEY = 'K'.repeat(43);
  it('same per-team address, new token → the team key stays', async () => {
    const team = 'https://relay.example/r/lincoln';
    settings.setMany({ pairingRelayUrl: team, pairingRelayToken: 'old-team-token', teamSessionsKey: KEY });
    initRelayJoin();
    host.handler!({ relayUrl: team, token: 'new-team-token' });
    await vi.waitFor(() => expect(settings.get('pairingRelayToken')).toBe('new-team-token'));
    expect(settings.get('teamSessionsKey')).toBe(KEY);
  });

  it('a shared address (a team per token) or another relay → no key carried over', () => {
    settings.setMany({ pairingRelayUrl: OLD.url, pairingRelayToken: OLD.token, teamSessionsKey: KEY });
    adoptRelay(OLD.url, 'another-teams-token');
    expect(settings.get('teamSessionsKey')).toBe('');
    settings.setMany({ pairingRelayUrl: 'https://relay.example/r/lincoln', pairingRelayToken: 't1', teamSessionsKey: KEY });
    adoptRelay('https://relay.example/r/other', 't1');
    expect(settings.get('teamSessionsKey')).toBe('');
  });
});
