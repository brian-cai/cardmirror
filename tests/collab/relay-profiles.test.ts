// @vitest-environment jsdom
/**
 * Saved relays: saving a custom relay once it connects, matching by URL +
 * token fingerprint, labels (the relay's own name, renames), switching
 * (team key swapped both ways without loss, the built-in relay, a live
 * session's confirm), team directory state per relay, removing, the
 * status-bar menu and the Settings list, and settings import/export.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const host = vi.hoisted(() => ({ check: { custom: true, ok: true, status: 200 }, polls: 0, checks: 0 }));
vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      pairingRelayCheck: async () => {
        host.checks++;
        return host.check;
      },
      pairingPollNow: async () => void host.polls++,
    }),
  };
});
const toasts = vi.hoisted(() => [] as string[]);
vi.mock('../../src/editor/toast.js', () => ({ showToast: (m: string) => toasts.push(m) }));
import {
  activeProfile,
  currentRelayLabel,
  defaultRelayLabel,
  findProfile,
  keyBelongsHere,
  noteTeamKeyOrigin,
  profileKey,
  relabelFromInfo,
  relayEdited,
  relayHostPath,
  rememberConnectedRelay,
  removeProfile,
  renameProfile,
  switchRelay,
  BUILTIN_RELAY,
  type SwitchHooks,
} from '../../src/editor/collab/relay-profiles.js';
import {
  buildSavedRelaysSection,
  checkCurrentRelay,
  relayMenuEntries,
  switchRelayNow,
  toggleRelayMenu,
  __resetRelayProfilesUiForTests,
  afterSwitchRefresh,
} from '../../src/editor/collab/relay-profiles-ui.js';
import { directoryKey, directoryState } from '../../src/editor/collab/team-directory.js';
import { mergeImportedSettings } from '../../src/editor/settings-import.js';
import { settings, type RelayProfile, type Settings } from '../../src/editor/settings.js';
import type { RelayInfo } from '../../src/editor/collab/relay-info.js';

const HS = { url: 'https://hs.relay.example/relay', token: 'hs-token' };
const COLLEGE = { url: 'https://college.example/r/squad', token: 'college-token' };
const KEY_A = 'A'.repeat(42) + 'A';
const KEY_B = 'B'.repeat(42) + 'A';
const KEY_C = 'C'.repeat(42) + 'A';

const info = (name: string, label: string): RelayInfo => ({
  v: 1,
  operator: { name, url: '', support: '', status: '', manage: '' },
  access: { label, status: 'active', expiresAt: null, installs: null },
  notice: null,
  clients: [],
});

function useRelay(r: { url: string; token: string }): void {
  settings.set('pairingRelayToken', r.token);
  settings.set('pairingRelayUrl', r.url);
}

/** Save `r` as if it connected, with `key` as its team key. */
function saved(r: { url: string; token: string }, key: string, now = 1000): RelayProfile {
  useRelay(r);
  settings.set('teamSessionsKey', key);
  return rememberConnectedRelay({ now })!;
}

let refreshes = 0;

const noSession: SwitchHooks = {
  sessionLive: () => false,
  confirmLeave: async () => true,
  leaveSessions: async () => true,
};

beforeEach(() => {
  __resetRelayProfilesUiForTests();
  toasts.length = 0;
  host.check = { custom: true, ok: true, status: 200 };
  host.polls = 0;
  host.checks = 0;
  afterSwitchRefresh.run = () => void refreshes++;
  refreshes = 0;
  settings.set('relayProfiles', []);
  settings.set('relayBuiltinTeamKey', '');
  settings.set('teamSessionsKey', '');
  settings.set('teamKeyOrigins', []);
  settings.set('teamDirectoryRelays', []);
  settings.set('pairingEnabled', true);
  useRelay({ url: '', token: '' });
});

// ── saving ────────────────────────────────────────────────────────────

describe('saving a relay on connect', () => {
  it('saves the current custom relay with its team key; built-in saves nothing', () => {
    expect(rememberConnectedRelay()).toBeNull();
    const p = saved(HS, KEY_A, 5);
    expect(settings.get('relayProfiles')).toEqual([
      { id: p.id, label: 'hs.relay.example/relay', labelCustom: false, url: HS.url, token: HS.token, teamKey: KEY_A, lastUsed: 5 },
    ]);
    expect(activeProfile()?.id).toBe(p.id);
  });

  it('matches by URL + token fingerprint: same pair updates; a new token at a per-team address updates it too', () => {
    const a = saved(COLLEGE, KEY_A, 1);
    const again = saved({ url: COLLEGE.url + '/', token: COLLEGE.token }, KEY_A, 2);
    expect(again.id).toBe(a.id);
    expect(settings.get('relayProfiles')).toHaveLength(1);
    expect(settings.get('relayProfiles')[0]!.lastUsed).toBe(2);
    expect(profileKey(a)).not.toContain(COLLEGE.token);
    expect(findProfile(settings.get('relayProfiles'), COLLEGE.url, COLLEGE.token)?.id).toBe(a.id);
    // Rotated token at ".../r/squad": the same saved relay, with the new token and the team key kept.
    renameProfile(a.id, 'Squad');
    settings.set('teamDirectoryRelays', [{ key: directoryKey(COLLEGE.url, COLLEGE.token), imported: true, dismissedRevision: -1, revision: 4, hasKey: false }]);
    const rotated = saved({ url: COLLEGE.url, token: 'another' }, KEY_A, 3);
    expect(rotated.id).toBe(a.id);
    expect(settings.get('relayProfiles')).toEqual([
      { id: a.id, label: 'Squad', labelCustom: true, url: COLLEGE.url, token: 'another', teamKey: KEY_A, lastUsed: 3 },
    ]);
    expect(settings.get('teamDirectoryRelays').map((d) => [d.key, d.imported])).toEqual([[directoryKey(COLLEGE.url, 'another'), true]]);
    // Another address is another relay.
    expect(saved(HS, '', 4).id).not.toBe(a.id);
    expect(settings.get('relayProfiles')).toHaveLength(2);
  });

  it('a new token at a shared address is another team: a new saved relay, its own team list state', () => {
    const a = saved(HS, KEY_A, 1);
    settings.set('teamDirectoryRelays', [{ key: directoryKey(HS.url, HS.token), imported: true, dismissedRevision: -1, revision: 4, hasKey: true }]);
    const b = saved({ url: HS.url, token: 'debater-token' }, KEY_B, 2);
    expect(b.id).not.toBe(a.id);
    expect(settings.get('relayProfiles').map((p) => [p.token, p.teamKey])).toEqual([
      [HS.token, KEY_A],
      ['debater-token', KEY_B],
    ]);
    expect(settings.get('teamDirectoryRelays').map((d) => d.key)).toEqual([directoryKey(HS.url, HS.token)]);
  });

  it('only a relay the check accepts is saved (desktop check)', async () => {
    useRelay(HS);
    expect(await checkCurrentRelay()).toBe(true);
    host.check = { custom: true, ok: false, status: 401 };
    expect(await checkCurrentRelay()).toBe(false);
    useRelay({ url: '', token: '' });
    expect(await checkCurrentRelay()).toBe(false);
  });
});

// ── labels ────────────────────────────────────────────────────────────

describe('labels', () => {
  it('defaults to the relay operator + access label, else host + path', () => {
    expect(defaultRelayLabel(HS.url)).toBe('hs.relay.example/relay');
    expect(defaultRelayLabel(HS.url, info('Squad', 'Coach access'))).toBe('Squad · Coach access');
    expect(defaultRelayLabel(HS.url, info('', 'Squad access'))).toBe('Squad access');
    // A per-team address is named after its team part, before the relay's own labels.
    expect(defaultRelayLabel('https://relay.example/r/collegiate/', info('Squad', 'Coach access'))).toBe('collegiate');
    expect(defaultRelayLabel('https://relay.example/r/lincoln%20hs')).toBe('lincoln hs');
    expect(relayHostPath('https://relay.example/')).toBe('relay.example');
  });

  it('takes the relay’s own name until renamed; an empty rename goes back', () => {
    const p = saved(HS, '');
    relabelFromInfo(info('Squad', 'Coach access'));
    expect(activeProfile()!.label).toBe('Squad · Coach access');
    renameProfile(p.id, '  HS team  ');
    expect(activeProfile()).toMatchObject({ label: 'HS team', labelCustom: true });
    relabelFromInfo(info('Other', 'x'));
    rememberConnectedRelay({ info: info('Other', 'x') });
    expect(activeProfile()!.label).toBe('HS team');
    renameProfile(p.id, '');
    expect(activeProfile()).toMatchObject({ label: 'hs.relay.example/relay', labelCustom: false });
    expect(currentRelayLabel()).toBe('hs.relay.example/relay');
  });
});

// ── switching ─────────────────────────────────────────────────────────

describe('switching', () => {
  it('swaps the team key both ways without losing either', async () => {
    const hs = saved(HS, KEY_A);
    const college = saved(COLLEGE, KEY_B);
    expect(await switchRelay(hs.id, noSession)).toBe('switched');
    expect(settings.get('pairingRelayUrl')).toBe(HS.url);
    expect(settings.get('pairingRelayToken')).toBe(HS.token);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    // A key picked up while here (a team file / the relay) goes with it.
    settings.set('teamSessionsKey', KEY_C);
    expect(await switchRelay(college.id, noSession)).toBe('switched');
    expect(settings.get('teamSessionsKey')).toBe(KEY_B);
    expect(await switchRelay(hs.id, noSession)).toBe('switched');
    expect(settings.get('teamSessionsKey')).toBe(KEY_C);
    const byId = Object.fromEntries(settings.get('relayProfiles').map((p) => [p.id, p.teamKey]));
    expect(byId).toEqual({ [hs.id]: KEY_C, [college.id]: KEY_B });
    expect(await switchRelay(hs.id, noSession)).toBe('unchanged');
    expect(await switchRelay('nope', noSession)).toBe('missing');
  });

  it('the built-in relay: clears the custom relay, keeps saved ones, has its own key', async () => {
    settings.set('teamSessionsKey', KEY_C); // the key in use on the built-in relay
    const hs = { ...HS };
    useRelay(hs);
    const p = rememberConnectedRelay()!; // first connect carries the key in use
    settings.set('teamSessionsKey', KEY_A);
    expect(await switchRelay(BUILTIN_RELAY, noSession)).toBe('switched');
    expect(settings.get('pairingRelayUrl')).toBe('');
    expect(settings.get('pairingRelayToken')).toBe('');
    expect(settings.get('relayProfiles')).toHaveLength(1);
    expect(settings.get('relayProfiles')[0]!.teamKey).toBe(KEY_A);
    expect(currentRelayLabel()).toBe('Built-in relay');
    settings.set('teamSessionsKey', KEY_B);
    expect(await switchRelay(p.id, noSession)).toBe('switched');
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    expect(settings.get('relayBuiltinTeamKey')).toBe(KEY_B);
    expect(await switchRelay(BUILTIN_RELAY, noSession)).toBe('switched');
    expect(settings.get('teamSessionsKey')).toBe(KEY_B);
  });

  it('an unsaved custom relay is saved on the way out, so its key is kept', async () => {
    const college = saved(COLLEGE, KEY_B);
    useRelay(HS);
    settings.set('teamSessionsKey', KEY_A);
    expect(await switchRelay(college.id, noSession)).toBe('switched');
    expect(findProfile(settings.get('relayProfiles'), HS.url, HS.token)?.teamKey).toBe(KEY_A);
  });

  it('in a session: asks, leaves, then switches; No or a failed leave changes nothing', async () => {
    const hs = saved(HS, KEY_A);
    const college = saved(COLLEGE, KEY_B);
    const calls: string[] = [];
    const hooks = (confirm: boolean, leave: boolean): SwitchHooks => ({
      sessionLive: () => true,
      confirmLeave: async (label) => (calls.push(`confirm:${label}`), confirm),
      leaveSessions: async () => (calls.push('leave'), leave),
    });
    expect(await switchRelay(hs.id, hooks(false, true))).toBe('cancelled');
    expect(calls).toEqual(['confirm:squad']);
    expect(settings.get('pairingRelayUrl')).toBe(COLLEGE.url);
    expect(await switchRelay(hs.id, hooks(true, false))).toBe('failed');
    expect(settings.get('pairingRelayUrl')).toBe(COLLEGE.url);
    expect(settings.get('teamSessionsKey')).toBe(KEY_B);
    calls.length = 0;
    expect(await switchRelay(hs.id, hooks(true, true))).toBe('switched');
    expect(calls).toEqual(['confirm:squad', 'leave']);
    expect(settings.get('pairingRelayUrl')).toBe(HS.url);
    expect(college.id).not.toBe(hs.id);
  });

  it('switchRelayNow toasts, checks the mailbox and refreshes relay info + team directory', async () => {
    const hs = saved(HS, KEY_A);
    saved(COLLEGE, KEY_B);
    expect(await switchRelayNow(hs.id, noSession)).toBe('switched');
    expect(refreshes).toBe(1);
    expect(host.polls).toBe(1);
    expect(toasts).toEqual(['Switched to hs.relay.example/relay.']);
  });

  it('typing a saved relay’s address swaps to its key; an unknown one starts with none (never another team’s)', () => {
    saved(HS, KEY_A);
    saved(COLLEGE, KEY_B);
    let prev = { ...COLLEGE };
    useRelay(HS);
    relayEdited(prev);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    prev = { ...HS };
    useRelay({ url: 'https://typo.example/relay', token: HS.token });
    relayEdited(prev);
    expect(settings.get('teamSessionsKey')).toBe('');
    expect(keyBelongsHere(KEY_A)).toBe(false);
    // Fixing the typo gets the key back.
    prev = { url: 'https://typo.example/relay', token: HS.token };
    useRelay(HS);
    relayEdited(prev);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
    expect(keyBelongsHere(KEY_A)).toBe(true);
    expect(findProfile(settings.get('relayProfiles'), COLLEGE.url, COLLEGE.token)?.teamKey).toBe(KEY_B);
    // A new token at the same shared address is another team: no key.
    prev = { ...HS };
    useRelay({ url: HS.url, token: 'debater-token' });
    relayEdited(prev);
    expect(settings.get('teamSessionsKey')).toBe('');
  });

  it('a key from a team file goes to whichever relay the team uses; a relay list’s key only back to that relay', () => {
    saved(COLLEGE, KEY_B);
    // The team moved relays and carried its key in a team file.
    useRelay(HS);
    settings.set('teamSessionsKey', KEY_B);
    expect(keyBelongsHere(KEY_B)).toBe(false); // no record: the old guess
    noteTeamKeyOrigin(KEY_B, 'file');
    expect(keyBelongsHere(KEY_B)).toBe(true);
    // A key taken from the college relay's list stays there.
    noteTeamKeyOrigin(KEY_C, { relay: COLLEGE });
    expect(keyBelongsHere(KEY_C)).toBe(false);
    useRelay(COLLEGE);
    expect(keyBelongsHere(KEY_C)).toBe(true);
    noteTeamKeyOrigin(KEY_A, 'minted');
    useRelay(HS);
    expect(keyBelongsHere(KEY_A)).toBe(true);
  });

  it('a new token at the same per-team address (a rotation) keeps the key', () => {
    saved(COLLEGE, KEY_B);
    useRelay({ url: COLLEGE.url, token: 'rotated' });
    relayEdited(COLLEGE);
    expect(settings.get('teamSessionsKey')).toBe(KEY_B);
    expect(keyBelongsHere(KEY_B)).toBe(true);
  });

  it('an unsaved custom relay’s key is kept when typing another address', () => {
    useRelay({ url: 'https://never.example/relay', token: 't' });
    settings.set('teamSessionsKey', KEY_C);
    useRelay(HS);
    relayEdited({ url: 'https://never.example/relay', token: 't' });
    expect(settings.get('teamSessionsKey')).toBe('');
    expect(findProfile(settings.get('relayProfiles'), 'https://never.example/relay', 't')?.teamKey).toBe(KEY_C);
  });
});

// ── per-relay state, remove ───────────────────────────────────────────

describe('team directory state and removing', () => {
  it('each saved relay has its own team directory state; removing drops it', async () => {
    const hs = saved(HS, '');
    const college = saved(COLLEGE, '');
    settings.set('teamDirectoryRelays', [
      { key: directoryKey(HS.url, HS.token), imported: true, dismissedRevision: -1, revision: 4, hasKey: false },
      { key: directoryKey(COLLEGE.url, COLLEGE.token), imported: false, dismissedRevision: 9, revision: 9, hasKey: false },
    ]);
    expect(profileKey(hs)).toBe(directoryKey(HS.url, HS.token));
    await switchRelay(hs.id, noSession);
    expect(directoryState(directoryKey(settings.get('pairingRelayUrl'), settings.get('pairingRelayToken'))).imported).toBe(true);
    await switchRelay(college.id, noSession);
    expect(directoryState(directoryKey(settings.get('pairingRelayUrl'), settings.get('pairingRelayToken')))).toMatchObject({
      imported: false,
      dismissedRevision: 9,
    });
    expect(removeProfile(college.id)).toBe(false); // in use
    expect(removeProfile(hs.id)).toBe(true);
    expect(settings.get('relayProfiles').map((p) => p.id)).toEqual([college.id]);
    expect(settings.get('teamDirectoryRelays').map((s) => s.key)).toEqual([directoryKey(COLLEGE.url, COLLEGE.token)]);
  });
});

// ── menu + settings list ──────────────────────────────────────────────

describe('quick switch menu and Saved relays list', () => {
  it('lists saved relays (most recent first) with a check on the current one, then the built-in relay', async () => {
    const hs = saved(HS, '', 1);
    const college = saved(COLLEGE, '', 2);
    expect(relayMenuEntries().map((e) => [e.id, e.current])).toEqual([
      [college.id, true],
      [hs.id, false],
      [BUILTIN_RELAY, false],
    ]);
    toggleRelayMenu();
    const menu = document.getElementById('relay-switch-menu')!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('.pmd-relay-menu-item')];
    expect(items.map((b) => b.querySelector('.pmd-relay-menu-label')?.textContent ?? b.textContent)).toEqual([
      'squad',
      'hs.relay.example/relay',
      'Built-in relay',
      'Manage saved relays…',
    ]);
    expect(items[0]!.getAttribute('aria-checked')).toBe('true');
    items[1]!.click();
    await vi.waitFor(() => expect(settings.get('pairingRelayUrl')).toBe(HS.url));
    expect(document.getElementById('relay-switch-menu')).toBeNull();
  });

  it('the Settings list: Use / Rename / Remove, In use for the current one, Built-in relay last', () => {
    saved(HS, '', 1);
    saved(COLLEGE, '', 2);
    const cleanups: Array<() => void> = [];
    const el = buildSavedRelaysSection((fn) => cleanups.push(fn));
    const rows = [...el.querySelectorAll('.pmd-saved-relay')].map((r) => ({
      label: r.querySelector('.pmd-saved-relay-label')!.textContent,
      buttons: [...r.querySelectorAll('button')].map((b) => `${b.textContent}${b.disabled ? '(off)' : ''}`),
    }));
    expect(rows).toEqual([
      { label: 'squad', buttons: ['In use(off)', 'Rename', 'Remove(off)'] },
      { label: 'hs.relay.example/relay', buttons: ['Use', 'Rename', 'Remove'] },
      { label: 'Built-in relay', buttons: ['Use'] },
    ]);
    cleanups.forEach((fn) => fn());
  });
});

// ── settings import / export ──────────────────────────────────────────

describe('settings import and export', () => {
  it('exports saved relays with their tokens, like the single custom relay', () => {
    saved(HS, KEY_A);
    const out = settings.exportObject();
    expect(out['pairingRelayToken']).toBe(HS.token);
    expect((out['relayProfiles'] as RelayProfile[])[0]!.token).toBe(HS.token);
  });

  it('import keeps yours (with keys), adds the file’s new ones without a team key, skips duplicates', async () => {
    const mine = saved(HS, KEY_A);
    settings.set('relayBuiltinTeamKey', KEY_C);
    const incoming = {
      relayProfiles: [
        { id: mine.id, label: 'theirs', labelCustom: true, url: HS.url, token: HS.token, teamKey: KEY_B, lastUsed: 9 },
        { id: mine.id, label: 'College', labelCustom: true, url: COLLEGE.url, token: COLLEGE.token, teamKey: KEY_B, lastUsed: 9 },
      ],
      relayBuiltinTeamKey: KEY_B,
    };
    const { merged } = await mergeImportedSettings(settings.exportObject() as unknown as Settings, incoming);
    const list = merged['relayProfiles'] as RelayProfile[];
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(mine);
    expect(list[1]).toMatchObject({ label: 'College', url: COLLEGE.url, token: COLLEGE.token, teamKey: '' });
    expect(list[1]!.id).not.toBe(mine.id);
    expect(merged['relayBuiltinTeamKey']).toBe(KEY_C);
  });
});

// ── live sessions seam ────────────────────────────────────────────────

describe('leaving sessions for a switch', () => {
  it('with no live session there is nothing to leave', async () => {
    const hooks = await import('../../src/editor/collab/collab-hooks.js');
    let called = 0;
    hooks.setCollabRelaySwitchLeaver(async () => (called++, false));
    expect(await hooks.collabLeaveAllForRelaySwitch()).toBe(true);
    expect(called).toBe(0);
    hooks.setCollabRelaySwitchLeaver(null);
  });
});

// ── boot wiring (last: its settings subscription outlives the test) ────

describe('startRelayProfiles', () => {
  it('saves a custom relay once it connects, and a settled edit to a saved address swaps keys', async () => {
    const { startRelayProfiles } = await import('../../src/editor/collab/relay-profiles-ui.js');
    saved(COLLEGE, KEY_B);
    useRelay(HS);
    settings.set('teamSessionsKey', KEY_A);
    vi.useFakeTimers();
    try {
      startRelayProfiles();
      await vi.waitFor(() => expect(findProfile(settings.get('relayProfiles'), HS.url, HS.token)?.teamKey).toBe(KEY_A));
      // Type the college relay's address in Settings: once it settles,
      // HS keeps KEY_A and the college key comes back.
      settings.set('pairingRelayToken', COLLEGE.token);
      settings.set('pairingRelayUrl', COLLEGE.url);
      expect(settings.get('teamSessionsKey')).toBe(KEY_A);
      await vi.advanceTimersByTimeAsync(900);
      expect(settings.get('teamSessionsKey')).toBe(KEY_B);
      expect(findProfile(settings.get('relayProfiles'), HS.url, HS.token)?.teamKey).toBe(KEY_A);
      expect(host.checks).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
