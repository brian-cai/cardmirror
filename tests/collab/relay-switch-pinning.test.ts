/**
 * Relay switches never cross wires (2026-10-23 review):
 * - a client keeps the relay (URL and Settings token) it was made for, so
 *   a live session survives a Settings edit instead of 404ing on the new
 *   relay and tearing itself down;
 * - mid-edit (the new relay's URL typed, the old relay's token still in
 *   the field) nothing gets a client: one relay's token never goes to
 *   another host;
 * - a team file's "Use team relay" puts the file's key on the team's relay.
 */
const store = new Map<string, string>();
(globalThis as Record<string, unknown>)['window'] = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage,
  addEventListener: () => {},
  removeEventListener: () => {},
  location: { search: '', href: 'http://localhost/' },
};
(globalThis as Record<string, unknown>)['document'] = {
  addEventListener: () => {},
  removeEventListener: () => {},
  visibilityState: 'visible',
};

import { describe, it, expect, beforeEach } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import { relayClient } from '../../src/editor/collab/collab-relay.js';
import { adoptRelay, tokenFromAnotherHost } from '../../src/editor/collab/relay-profiles.js';
import { applyTeamKeyFromFile } from '../../src/editor/pairing/team-file-sync.js';

const A = { url: 'https://relay-a.example/r/lincoln', token: 'tok-a' };
const B = { url: 'https://relay-b.example/r/nyu', token: 'tok-b' };
const KEY_OLD = 'O'.repeat(42) + 'A';
const KEY_FILE = 'F'.repeat(42) + 'A';

const profile = (p: { url: string; token: string }, teamKey = '') => ({
  id: p.token, label: p.url, labelCustom: false, url: p.url, token: p.token, teamKey, lastUsed: 1,
});

beforeEach(() => {
  store.clear();
  settings.set('relayProfiles', []);
  settings.set('teamSessionsKey', '');
  settings.set('relayBuiltinTeamKey', '');
  settings.set('pairingRelayUrl', A.url);
  settings.set('pairingRelayToken', A.token);
});

describe('pinned clients', () => {
  it('a client keeps its relay and token after Settings change', () => {
    const client = relayClient()!;
    settings.set('pairingRelayUrl', B.url);
    settings.set('pairingRelayToken', B.token);
    expect(client.opts.baseUrl()).toBe(A.url);
    expect(client.opts.token()).toBe(A.token);
    const next = relayClient()!;
    expect(next.opts.baseUrl()).toBe(B.url);
    expect(next.opts.token()).toBe(B.token);
  });
});

describe('mid-edit token', () => {
  it('flags a saved relay token typed under another host', () => {
    const list = [profile(A)];
    expect(tokenFromAnotherHost(B.url, A.token, list)).toBe(true);
    expect(tokenFromAnotherHost(B.url, B.token, list)).toBe(false);
    // Same host, another /r/ name: same operator, fine.
    expect(tokenFromAnotherHost('https://relay-a.example/r/other', A.token, list)).toBe(false);
    expect(tokenFromAnotherHost(A.url, A.token, list)).toBe(false);
    expect(tokenFromAnotherHost(B.url, '', list)).toBe(false);
  });

  it('no client while the old token sits under the new URL', () => {
    settings.set('relayProfiles', [profile(A)]);
    settings.set('pairingRelayUrl', B.url);
    expect(relayClient()).toBeNull();
    settings.set('pairingRelayToken', B.token);
    expect(relayClient()?.opts.token()).toBe(B.token);
  });
});

describe('team file "Use team relay"', () => {
  it('the file key lands on the new relay; the old relay keeps its own', () => {
    settings.set('pairingRelayUrl', '');
    settings.set('pairingRelayToken', '');
    settings.set('teamSessionsKey', KEY_OLD);
    adoptRelay(B.url, B.token);
    expect(settings.get('pairingRelayUrl')).toBe(B.url);
    expect(settings.get('relayBuiltinTeamKey')).toBe(KEY_OLD);
    expect(settings.get('teamSessionsKey')).toBe('');
    applyTeamKeyFromFile({ kind: 'cardmirror-team', version: 1, name: 'NYU', people: [], groups: [], teamKey: KEY_FILE } as never);
    expect(settings.get('teamSessionsKey')).toBe(KEY_FILE);
  });

  it('a relay already saved here gets its saved key back', () => {
    settings.set('relayProfiles', [profile(B, KEY_FILE)]);
    settings.set('teamSessionsKey', KEY_OLD);
    adoptRelay(B.url, B.token);
    expect(settings.get('teamSessionsKey')).toBe(KEY_FILE);
    expect(settings.get('relayProfiles').find((p) => p.url === A.url)?.teamKey).toBe(KEY_OLD);
  });
});
