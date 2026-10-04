import { describe, expect, it } from 'vitest';
import { buildTeamFile, mergeTeamFile, parseTeamFile } from '../../src/editor/pairing/team-file.js';

const COACH = 'cmk1.coachcode';
const ANA = 'cmk1.anacode';
const BEN = 'cmk1.bencode';
const CAL = 'cmk1.calcode';

function coachFile(extra?: { relay?: boolean; sessions?: boolean }) {
  return buildTeamFile({
    name: 'Westside',
    ownCode: COACH,
    ownName: 'Coach B',
    partners: [
      { code: ANA, name: 'Ana' },
      { code: BEN, name: 'Ben' },
    ],
    groups: [{ id: 'grp-1', label: 'Ana/Ben', memberCodes: [ANA, BEN, 'cmk1.stranger'] }],
    relay: extra?.relay ? { url: 'https://relay.example.com', token: 'tok' } : null,
    sessions: extra?.sessions ? [{ roomId: 'r1', shareCode: 'share-1', docTitle: 'Aff' }] : [],
  });
}

describe('team file', () => {
  it('includes the exporter, their contacts and groups; drops unknown group members', () => {
    const f = coachFile();
    expect(f.people).toEqual([
      { code: COACH, name: 'Coach B' },
      { code: ANA, name: 'Ana' },
      { code: BEN, name: 'Ben' },
    ]);
    expect(f.groups).toEqual([{ label: 'Ana/Ben', memberCodes: [ANA, BEN] }]);
    expect(f.relay).toBeUndefined();
    expect(f.sessions).toBeUndefined();
  });

  it('carries relay and sessions only when asked', () => {
    const f = coachFile({ relay: true, sessions: true });
    expect(f.relay).toEqual({ url: 'https://relay.example.com', token: 'tok' });
    expect(f.sessions?.[0]?.shareCode).toBe('share-1');
  });

  it('round-trips through JSON and rejects other files', () => {
    const f = coachFile({ relay: true, sessions: true });
    expect(parseTeamFile(JSON.parse(JSON.stringify(f)))).toEqual(f);
    expect(parseTeamFile({ kind: 'something-else' })).toBeNull();
    expect(parseTeamFile({ version: 1, settings: {} })).toBeNull();
    // A relay that isn't https is dropped rather than trusted.
    expect(parseTeamFile({ ...f, relay: { url: 'http://evil', token: 'x' } })?.relay).toBeUndefined();
  });

  it('merges into a student: adds the others, skips themselves, keeps their own contacts', () => {
    const r = mergeTeamFile({
      file: coachFile(),
      ownCode: ANA,
      partners: [{ code: CAL, name: 'Cal (mine)' }],
      groups: [],
    });
    expect(r.partners.map((p) => p.code)).toEqual([CAL, COACH, BEN]);
    expect(r.addedPeople).toBe(2);
    // Ana's copy of "Ana/Ben" is just Ben — you don't send to yourself.
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0]!.label).toBe('Ana/Ben');
    expect(r.groups[0]!.memberCodes).toEqual([BEN]);
  });

  it('re-importing changes nothing; an existing group gains missing members', () => {
    const first = mergeTeamFile({ file: coachFile(), ownCode: CAL, partners: [], groups: [] });
    const again = mergeTeamFile({ file: coachFile(), ownCode: CAL, partners: first.partners, groups: first.groups });
    expect(again.addedPeople).toBe(0);
    expect(again.addedGroups).toBe(0);
    expect(again.updatedGroups).toBe(0);
    const partial = mergeTeamFile({
      file: coachFile(),
      ownCode: CAL,
      partners: [{ code: ANA, name: 'Ana (renamed)' }],
      groups: [{ id: 'mine', label: 'ana/ben', memberCodes: [ANA] }],
    });
    expect(partial.partners.find((p) => p.code === ANA)?.name).toBe('Ana (renamed)');
    expect(partial.groups[0]!.memberCodes).toEqual([ANA, BEN]);
    expect(partial.updatedGroups).toBe(1);
  });
});
