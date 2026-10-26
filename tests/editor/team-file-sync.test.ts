// @vitest-environment jsdom
/**
 * Team file sync: importing a team file adds you to it, and the synced file
 * is re-read for new teammates (additive) — never rerouting the relay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const disk = vi.hoisted(() => ({ files: new Map<string, string>(), writes: 0 }));

vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      readTeamFile: async (path: string) => {
        const text = disk.files.get(path);
        return text == null ? null : { bytes: new TextEncoder().encode(text), mtimeMs: 1 };
      },
      writeFileAtPath: async (path: string, bytes: Uint8Array) => {
        disk.writes++;
        disk.files.set(path, new TextDecoder().decode(bytes));
      },
    }),
  };
});

const rooms = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../src/editor/collab/collab-store.js', () => ({
  loadRecentRoom: async (id: string) => rooms.get(id) ?? null,
  saveRecentRoom: async (r: { roomId: string }) => void rooms.set(r.roomId, r),
}));

import { settings } from '../../src/editor/settings.js';
import { addPersonToTeamFileJson, parseTeamFile } from '../../src/editor/pairing/team-file.js';
import { syncTeamFile } from '../../src/editor/pairing/team-file-sync.js';
import { noticeCount, __noticesForTests, __resetNoticesForTests } from '../../src/editor/status-notices.js';
import {
  acceptTeamReview,
  declineTeamReview,
  pendingTeamReview,
  __resetTeamReviewForTests,
} from '../../src/editor/pairing/team-review.js';

const ME = 'cmk1.MEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEM';
const ANA = 'cmk1.ANAANAANAANAANAANAANAANAANAANAANAANAANAANA';
const BEN = 'cmk1.BENBENBENBENBENBENBENBENBENBENBENBENBENBEN';
const PATH = '/Dropbox/Westside.cmteam';
const KEY_A = 'A'.repeat(42) + 'A';
const KEY_B = 'B'.repeat(42) + 'A';

const teamJson = (people: { name: string; code: string }[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'cardmirror-team', version: 1, name: 'Westside', people, groups: [], ...extra });

beforeEach(() => {
  disk.files.clear();
  disk.writes = 0;
  localStorage.clear();
  settings.set('pairingOwnCode', ME);
  settings.set('pairingDisplayName', 'Brian');
  settings.set('pairingPartners', []);
  settings.set('pairingGroups', []);
  settings.set('pairingRelayUrl', '');
  settings.set('pairingRelayToken', '');
  settings.set('teamFileSyncPath', PATH);
  settings.set('teamSessionsKey', '');
  __resetNoticesForTests();
  __resetTeamReviewForTests();
  rooms.clear();
});

describe('adding yourself to a team file', () => {
  it('appends your entry and keeps every other field', () => {
    const raw = JSON.parse(teamJson([{ name: 'Coach', code: ANA }], { relay: { url: 'https://r', token: 't' }, note: 'hand edit' }));
    const next = addPersonToTeamFileJson(raw, { code: ME, name: 'Brian' })!;
    expect(next['people']).toEqual([{ name: 'Coach', code: ANA }, { name: 'Brian', code: ME }]);
    expect(next['relay']).toEqual({ url: 'https://r', token: 't' });
    expect(next['note']).toBe('hand edit');
    expect(addPersonToTeamFileJson(next, { code: ME, name: 'Brian' })).toBeNull(); // already listed
  });
});

describe('syncing the team file', () => {
  it('picks up new teammates and adds you when missing', async () => {
    disk.files.set(PATH, teamJson([{ name: 'Coach', code: ANA }, { name: 'Ben', code: BEN }]));
    expect(await syncTeamFile(true)).toBe('changed');
    expect(settings.get('pairingPartners').map((p) => p.name)).toEqual(['Coach', 'Ben']);
    const file = parseTeamFile(JSON.parse(disk.files.get(PATH)!))!;
    expect(file.people.map((p) => p.name)).toEqual(['Coach', 'Ben', 'Brian']);
    // A second pass changes nothing and writes nothing.
    disk.writes = 0;
    expect(await syncTeamFile(true)).toBe('unchanged');
    expect(disk.writes).toBe(0);
  });

  it('never applies a relay from the file on its own', async () => {
    disk.files.set(PATH, teamJson([{ name: 'Brian', code: ME }], { relay: { url: 'https://evil.example', token: 'x' } }));
    await syncTeamFile(true);
    expect(settings.get('pairingRelayUrl')).toBe('');
  });

  it('does not add you without a display name', async () => {
    settings.set('pairingDisplayName', '');
    disk.files.set(PATH, teamJson([{ name: 'Coach', code: ANA }], { teamKey: KEY_A }));
    await syncTeamFile(true);
    expect(disk.writes).toBe(0);
  });

  it('takes the file\u2019s team key when this machine has none', async () => {
    disk.files.set(PATH, teamJson([{ name: 'Brian', code: ME }], { teamKey: KEY_A }));
    await syncTeamFile(true);
    expect(settings.get('teamSessionsKey')).toBe(KEY_A);
  });

  it('never replaces this machine\u2019s team key; a different one gets a quiet notice', async () => {
    settings.set('teamSessionsKey', KEY_B);
    disk.files.set(PATH, teamJson([{ name: 'Brian', code: ME }], { teamKey: KEY_A }));
    await syncTeamFile(true);
    expect(settings.get('teamSessionsKey')).toBe(KEY_B);
    expect(noticeCount()).toBe(1);
    // The file keeps its own key too.
    expect(parseTeamFile(JSON.parse(disk.files.get(PATH)!))!.teamKey).toBe(KEY_A);
  });

  it('gives a file without a key this machine\u2019s (minting one), every other field kept', async () => {
    disk.files.set(PATH, teamJson([{ name: 'Brian', code: ME }], { note: 'hand edit' }));
    await syncTeamFile(true);
    const key = settings.get('teamSessionsKey');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const raw = JSON.parse(disk.files.get(PATH)!);
    expect(raw.teamKey).toBe(key);
    expect(raw.note).toBe('hand edit');
    disk.writes = 0;
    await syncTeamFile(true);
    expect(disk.writes).toBe(0);
  });

  it('reports a missing file', async () => {
    expect(await syncTeamFile(true)).toBe('failed');
  });

  it('adds new groups, but holds new members for a group you already have (with name + short code)', async () => {
    settings.set('pairingPartners', [{ code: ANA, name: 'Ana' }]);
    settings.set('pairingGroups', [{ id: 'grp-v', label: 'Varsity', memberCodes: [ANA] }]);
    disk.files.set(
      PATH,
      teamJson([{ name: 'Brian', code: ME }, { name: 'Ana', code: ANA }, { name: 'Ben', code: BEN }], {
        teamKey: KEY_A,
        groups: [{ label: 'varsity', members: ['Ana', 'Ben'] }, { label: 'Novice', members: ['Ben'] }],
      }),
    );
    await syncTeamFile(true);
    const groups = () => settings.get('pairingGroups').map((g) => [g.label, g.memberCodes]);
    expect(groups()).toEqual([['Varsity', [ANA]], ['Novice', [BEN]]]);
    const n = __noticesForTests().find((x) => x.key === 'team-review:file')!;
    expect(n.body).toContain('add to your group \u201cVarsity\u201d: Ben (BENB\u2026NBEN)');
    expect(n.action?.label).toBe('Review\u2026');
    // A later sync asks nothing new and applies nothing.
    await syncTeamFile(true);
    expect(groups()).toEqual([['Varsity', [ANA]], ['Novice', [BEN]]]);
    expect(await acceptTeamReview('file')).toBe(true);
    expect(groups()).toEqual([['Varsity', [ANA, BEN]], ['Novice', [BEN]]]);
    expect(__noticesForTests().some((x) => x.key === 'team-review:file')).toBe(false);
  });

  it('“Don’t add” sticks across syncs', async () => {
    settings.set('pairingPartners', [{ code: ANA, name: 'Ana' }, { code: BEN, name: 'Ben' }]);
    settings.set('pairingGroups', [{ id: 'grp-v', label: 'Varsity', memberCodes: [ANA] }]);
    disk.files.set(PATH, teamJson([{ name: 'Brian', code: ME }, { name: 'Ana', code: ANA }, { name: 'Ben', code: BEN }], {
      teamKey: KEY_A,
      groups: [{ label: 'Varsity', members: ['Ana', 'Ben'] }],
    }));
    await syncTeamFile(true);
    declineTeamReview('file');
    await syncTeamFile(true);
    expect(pendingTeamReview('file')).toBeNull();
    expect(settings.get('pairingGroups')[0]!.memberCodes).toEqual([ANA]);
  });

  it('flags a new person named like a contact and does not add them on its own', async () => {
    const FAKE = 'cmk1.FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
    settings.set('pairingPartners', [{ code: ANA, name: 'Ana Lopez' }]);
    disk.files.set(PATH, teamJson([{ name: 'Brian', code: ME }, { name: 'Ana Lopez', code: FAKE }], { teamKey: KEY_A }));
    await syncTeamFile(true);
    expect(settings.get('pairingPartners').map((p) => p.code)).toEqual([ANA]);
    const body = __noticesForTests().find((x) => x.key === 'team-review:file')!.body;
    expect(body).toContain('add contact Ana Lopez (FAKE\u2026FAKE)');
    expect(body).toContain('same name as your contact \u201cAna Lopez\u201d (ANAA\u2026AANA)');
  });

  it('puts the file\u2019s sessions in your recents only after a yes', async () => {
    disk.files.set(PATH, teamJson([{ name: 'Brian', code: ME }], {
      teamKey: KEY_A,
      sessions: [{ roomId: 'r1', shareCode: 'share-1', docTitle: 'Aff' }],
    }));
    await syncTeamFile(true);
    expect(rooms.size).toBe(0);
    expect(pendingTeamReview('file')!.sessions.map((x) => x.roomId)).toEqual(['r1']);
    expect(__noticesForTests().find((x) => x.key === 'team-review:file')!.body).toContain('\u201cAff\u201d');
    await acceptTeamReview('file');
    expect([...rooms.keys()]).toEqual(['r1']);
    // Offered once: a later sync doesn't ask again.
    await syncTeamFile(true);
    expect(pendingTeamReview('file')).toBeNull();
  });
});
