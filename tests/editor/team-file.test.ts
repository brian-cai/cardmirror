import { describe, expect, it } from 'vitest';
import {
  applyHeldChanges,
  buildTeamFile,
  describeHeldChanges,
  hasHeldChanges,
  mergeTeamFile,
  parseTeamFile,
  serializeTeamFile,
} from '../../src/editor/pairing/team-file.js';
import { shortPairingCode } from '../../src/editor/pairing/pairing-ids.js';

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
    expect(parseTeamFile(JSON.parse(serializeTeamFile(f)))).toEqual(f);
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

  it('re-importing changes nothing; an existing group’s new members are held for a yes', () => {
    const first = mergeTeamFile({ file: coachFile(), ownCode: CAL, partners: [], groups: [] });
    const again = mergeTeamFile({ file: coachFile(), ownCode: CAL, partners: first.partners, groups: first.groups });
    expect(again.addedPeople).toBe(0);
    expect(again.addedGroups).toBe(0);
    expect(again.updatedGroups).toBe(0);
    expect(hasHeldChanges(again.held)).toBe(false);
    const mine = { ownCode: CAL, partners: [{ code: ANA, name: 'Ana (renamed)' }], groups: [{ id: 'mine', label: 'ana/ben', memberCodes: [ANA] }] };
    const partial = mergeTeamFile({ file: coachFile(), ...mine });
    expect(partial.partners.find((p) => p.code === ANA)?.name).toBe('Ana (renamed)');
    // Ben is a new contact, but not yet in your group.
    expect(partial.partners.map((p) => p.code)).toContain(BEN);
    expect(partial.groups[0]!.memberCodes).toEqual([ANA]);
    expect(partial.updatedGroups).toBe(0);
    expect(partial.held.topUps).toEqual([{ groupId: 'mine', label: 'ana/ben', members: [{ code: BEN, name: 'Ben' }] }]);
    expect(describeHeldChanges(partial.held)).toEqual([`\u2022 add to your group \u201cana/ben\u201d: Ben (${shortPairingCode(BEN)})`]);
    const yes = applyHeldChanges({ held: partial.held, ownCode: CAL, partners: partial.partners, groups: partial.groups });
    expect(yes.groups[0]!.memberCodes).toEqual([ANA, BEN]);
    // Your own settings backup tops up as before.
    const backup = mergeTeamFile({ file: coachFile(), ...mine, topUp: true });
    expect(backup.groups[0]!.memberCodes).toEqual([ANA, BEN]);
    expect(backup.updatedGroups).toBe(1);
  });

  it('holds a new person named like one of your contacts, flagged with both codes', () => {
    const IMPOSTOR = 'cmk1.IMPIMPIMPIMPIMPIMPIMPIMPIMPIMPIMPIMPIMPIMPI';
    const file = parseTeamFile({
      kind: 'cardmirror-team',
      version: 1,
      name: 'T',
      people: [{ name: 'ana', code: IMPOSTOR }, { name: 'Ben', code: BEN }],
      groups: [{ label: 'Pair', members: ['ana', 'Ben'] }, { label: 'Solo', members: ['ana'] }],
    })!;
    const r = mergeTeamFile({ file, ownCode: CAL, partners: [{ code: ANA, name: 'Ana' }], groups: [] });
    expect(r.partners.map((p) => p.code)).toEqual([ANA, BEN]);
    // "Pair" is new and goes in with Ben; the look-alike waits.
    expect(r.groups.map((g) => [g.label, g.memberCodes])).toEqual([['Pair', [BEN]]]);
    expect(r.held.clashes).toEqual([{ code: IMPOSTOR, name: 'ana', clashesWith: { name: 'Ana', code: ANA } }]);
    expect(r.held.topUps.map((t) => [t.groupId === null, t.label, t.members.map((m) => m.code)])).toEqual([
      [false, 'Pair', [IMPOSTOR]],
      [true, 'Solo', [IMPOSTOR]],
    ]);
    const lines = describeHeldChanges(r.held);
    expect(lines[0]).toContain(`ana (${shortPairingCode(IMPOSTOR)})`);
    expect(lines[0]).toContain(`same name as your contact \u201cAna\u201d (${shortPairingCode(ANA)})`);
    expect(lines[1]).toContain('new group \u201cSolo\u201d');
    const yes = applyHeldChanges({ held: r.held, ownCode: CAL, partners: r.partners, groups: r.groups });
    expect(yes.partners.map((p) => p.code)).toEqual([ANA, BEN, IMPOSTOR]);
    expect(yes.groups.map((g) => [g.label, g.memberCodes])).toEqual([['Pair', [BEN, IMPOSTOR]], ['Solo', [IMPOSTOR]]]);
    expect(yes.createdGroupIds).toHaveLength(1);
  });

  it('short codes show the first and last four characters', () => {
    expect(shortPairingCode('cmk1.BENBENBENBENBENBENBENBENBENBENBENBENBENBEN')).toBe('BENB\u2026NBEN');
    expect(shortPairingCode(BEN)).toBe('bencode');
  });

  it('writes groups by member name, and a hand-edited file imports', () => {
    const text = serializeTeamFile(coachFile());
    const json = JSON.parse(text);
    expect(json.groups).toEqual([{ label: 'Ana/Ben', members: ['Ana', 'Ben'] }]);
    // Hand edit: add the coach to the group by name (any case), plus a
    // name that isn't a person (dropped).
    json.groups[0].members.push('coach b', 'Nobody');
    const parsed = parseTeamFile(json)!;
    expect(parsed.groups[0]!.memberCodes).toEqual([ANA, BEN, COACH]);
  });
});
