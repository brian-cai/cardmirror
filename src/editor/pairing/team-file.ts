/**
 * Team file — share a squad's send codes, groups, relay and live
 * collaboration sessions in one file, so nobody pastes codes by hand.
 *
 * A coach (or anyone) exports it from Settings → Collaboration; everyone
 * else imports it. Import MERGES: people are added by code (an existing
 * contact keeps its name; the importer's own code is skipped), new groups
 * are added, and the relay / sessions apply only when the importer agrees.
 * Members for a group the importer already has (matched by name), and a
 * new person named like an existing contact, are held for an explicit
 * yes (mergeTeamFile → held). Nothing the importer had is lost.
 *
 * The file is plain JSON meant to be editable by hand: people are
 * `{ "name", "code" }`, and groups list their members BY NAME
 * (`"members": ["Ana Lopez", "Ben Wu"]`), so moving someone between groups
 * is a one-line edit. (Older files listing `memberCodes` still import.)
 *
 * The file also carries the team key (`teamKey`, team-key.ts): the shared
 * secret team sessions are sealed with. Importing never replaces a key
 * this machine already has (mergeTeamKey).
 *
 * Pure module (no settings / DOM): build + merge + parse, unit-tested.
 */
import type { PairingGroup, PairingPartner } from '../settings.js';
import { generateGroupId, normalizePairingCode, shortPairingCode } from './pairing-ids.js';
import { isTeamKey } from './team-key.js';

export const TEAM_FILE_KIND = 'cardmirror-team';
export const TEAM_FILE_EXTENSION = 'cmteam';

export interface TeamFileSession {
  roomId: string;
  shareCode: string;
  guestPass?: string | null;
  docTitle: string;
}

/** Parsed / in-memory form: group members resolved to send codes. */
export interface TeamFile {
  kind: typeof TEAM_FILE_KIND;
  version: 1;
  /** Display name of the team, e.g. "Westside Debate". */
  name: string;
  people: { code: string; name: string }[];
  groups: { label: string; memberCodes: string[] }[];
  /** Private relay settings — only when the exporter chose to include them. */
  relay?: { url: string; token: string };
  /** Live collaboration rooms to offer under Join session. */
  sessions?: TeamFileSession[];
  /** Team sessions key (team-key.ts): base64url, 32 bytes. */
  teamKey?: string;
}

export function buildTeamFile(opts: {
  name: string;
  ownCode: string;
  ownName: string;
  partners: readonly PairingPartner[];
  groups: readonly PairingGroup[];
  relay?: { url: string; token: string } | null;
  sessions?: readonly TeamFileSession[];
  teamKey?: string | null;
}): TeamFile {
  const people = new Map<string, string>();
  const own = normalizePairingCode(opts.ownCode);
  // The exporter is on the team too: include their own code so importers
  // can send to them.
  if (own) people.set(own, opts.ownName.trim() || 'Coach');
  for (const p of opts.partners) {
    const code = normalizePairingCode(p.code);
    if (code && !people.has(code)) people.set(code, p.name.trim() || code.slice(0, 12));
  }
  const groups = opts.groups
    .map((g) => ({
      label: g.label.trim(),
      memberCodes: [...new Set(g.memberCodes.map(normalizePairingCode))].filter((c) => people.has(c)),
    }))
    .filter((g) => g.label);
  const file: TeamFile = {
    kind: TEAM_FILE_KIND,
    version: 1,
    name: opts.name.trim() || 'Team',
    people: [...people].map(([code, name]) => ({ code, name })),
    groups,
  };
  if (opts.relay && opts.relay.url.trim()) file.relay = { url: opts.relay.url.trim(), token: opts.relay.token };
  if (opts.sessions && opts.sessions.length > 0) {
    file.sessions = opts.sessions.map((s) => ({
      roomId: s.roomId,
      shareCode: s.shareCode,
      guestPass: s.guestPass ?? null,
      docTitle: s.docTitle,
    }));
  }
  if (isTeamKey(opts.teamKey)) file.teamKey = opts.teamKey;
  return file;
}

/** The JSON written to disk: like TeamFile, but groups name their members
 *  (`members`) instead of repeating codes — easy to edit by hand. */
export function serializeTeamFile(file: TeamFile): string {
  const nameOf = new Map(file.people.map((p) => [p.code, p.name]));
  const out = {
    kind: file.kind,
    version: file.version,
    name: file.name,
    people: file.people.map((p) => ({ name: p.name, code: p.code })),
    groups: file.groups.map((g) => ({
      label: g.label,
      members: g.memberCodes.map((c) => nameOf.get(c) ?? c),
    })),
    ...(file.relay ? { relay: file.relay } : {}),
    ...(file.sessions ? { sessions: file.sessions } : {}),
    ...(file.teamKey ? { teamKey: file.teamKey } : {}),
  };
  return JSON.stringify(out, null, 2) + '\n';
}

/** Validate an untrusted parsed object as a team file (dropping malformed
 *  entries), or null when it isn't one. */
export function parseTeamFile(raw: unknown): TeamFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<TeamFile>;
  if (r.kind !== TEAM_FILE_KIND || r.version !== 1) return null;
  const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const people = (Array.isArray(r.people) ? r.people : [])
    .map((p) => ({ code: normalizePairingCode(str((p as { code?: unknown })?.code, 2000)), name: str((p as { name?: unknown })?.name, 80) }))
    .filter((p) => p.code);
  const codes = new Set(people.map((p) => p.code));
  const byName = new Map(people.map((p) => [p.name.toLowerCase(), p.code]));
  // A member may be written as a person's name (the hand-editable form) or
  // as their send code; anyone not in `people` is dropped.
  const resolve = (v: unknown): string | null => {
    const t = str(v, 2000);
    if (!t) return null;
    const code = normalizePairingCode(t);
    if (codes.has(code)) return code;
    return byName.get(t.toLowerCase()) ?? null;
  };
  const groups = (Array.isArray(r.groups) ? r.groups : [])
    .map((g) => {
      const gg = g as { label?: unknown; members?: unknown; memberCodes?: unknown };
      const list = [
        ...(Array.isArray(gg.members) ? gg.members : []),
        ...(Array.isArray(gg.memberCodes) ? gg.memberCodes : []),
      ];
      return {
        label: str(gg.label, 80),
        memberCodes: [...new Set(list.map(resolve).filter((c): c is string => !!c))],
      };
    })
    .filter((g) => g.label);
  const file: TeamFile = { kind: TEAM_FILE_KIND, version: 1, name: str(r.name, 80) || 'Team', people, groups };
  const relayUrl = str(r.relay?.url, 500);
  if (relayUrl && /^https:\/\//i.test(relayUrl)) file.relay = { url: relayUrl, token: str(r.relay?.token, 500) };
  if (Array.isArray(r.sessions)) {
    const sessions = r.sessions
      .map((s) => ({
        roomId: str((s as TeamFileSession)?.roomId, 200),
        shareCode: str((s as TeamFileSession)?.shareCode, 4000),
        guestPass: str((s as TeamFileSession)?.guestPass, 2000) || null,
        docTitle: str((s as TeamFileSession)?.docTitle, 200) || 'Untitled',
      }))
      .filter((s) => s.roomId && s.shareCode);
    if (sessions.length > 0) file.sessions = sessions;
  }
  const teamKey = (r as { teamKey?: unknown }).teamKey;
  if (isTeamKey(teamKey)) file.teamKey = teamKey;
  return file;
}

/** Someone a file would add to a group you already have — held until you
 *  say yes (a shared file must not slip a stranger into "Varsity"). */
export interface HeldMember {
  code: string;
  name: string;
  /** A contact you already have under this name but another code. */
  clashesWith?: { name: string; code: string };
}

export interface GroupTopUp {
  /** Your group, or null for a group the file adds that has only held
   *  members (it's created when you say yes). */
  groupId: string | null;
  label: string;
  members: HeldMember[];
}

/** What a merge holds back for the user to confirm (applyHeldChanges). */
export interface HeldChanges {
  topUps: GroupTopUp[];
  /** New people named like a contact you have under another code: not
   *  added until you say yes. */
  clashes: HeldMember[];
}

export interface TeamMergeResult {
  partners: PairingPartner[];
  groups: PairingGroup[];
  addedPeople: number;
  addedGroups: number;
  /** Existing groups that gained members (only with `topUp`). */
  updatedGroups: number;
  /** Ids of the groups this merge created. */
  createdGroupIds: string[];
  held: HeldChanges;
}

/** Merge a team file's people and groups into the importer's own lists.
 *  New people and new groups go straight in; members for a group you
 *  already have, and a new person named like one of your contacts, are
 *  held (`held`) for a confirm — unless `topUp` (your own settings
 *  backup), which adds them as before. `match` picks the group a file
 *  group lands in (default: yours with the same name; 'skip' = neither
 *  top it up nor create it). */
export function mergeTeamFile(opts: {
  file: TeamFile;
  ownCode: string;
  partners: readonly PairingPartner[];
  groups: readonly PairingGroup[];
  topUp?: boolean;
  match?: (label: string, groups: readonly PairingGroup[]) => PairingGroup | null | 'skip';
}): TeamMergeResult {
  const own = normalizePairingCode(opts.ownCode);
  const partners = opts.partners.map((p) => ({ ...p }));
  const known = new Set(partners.map((p) => normalizePairingCode(p.code)));
  const byName = new Map<string, PairingPartner>();
  for (const p of partners) {
    const k = p.name.trim().toLowerCase();
    if (k && !byName.has(k)) byName.set(k, p);
  }
  const heldPeople = new Map<string, HeldMember>();
  let addedPeople = 0;
  for (const p of opts.file.people) {
    if (p.code === own || known.has(p.code)) continue;
    const name = p.name || p.code.slice(0, 12);
    const twin = byName.get(name.trim().toLowerCase());
    if (twin && !opts.topUp) {
      heldPeople.set(p.code, { code: p.code, name, clashesWith: { name: twin.name, code: normalizePairingCode(twin.code) } });
      continue;
    }
    partners.push({ code: p.code, name });
    known.add(p.code);
    addedPeople++;
  }
  const nameOf = new Map(partners.map((p) => [normalizePairingCode(p.code), p.name]));
  const heldMember = (c: string): HeldMember => heldPeople.get(c) ?? { code: c, name: nameOf.get(c) ?? c.slice(0, 12) };
  const groups = opts.groups.map((g) => ({ ...g, memberCodes: [...g.memberCodes] }));
  const match =
    opts.match ?? ((label: string, gs: readonly PairingGroup[]) => gs.find((x) => x.label.toLowerCase() === label.toLowerCase()) ?? null);
  const topUps: GroupTopUp[] = [];
  const createdGroupIds: string[] = [];
  let addedGroups = 0;
  let updatedGroups = 0;
  for (const g of opts.file.groups) {
    // The importer's own code is a member of their team's group too, but
    // you don't send to yourself — leave it out.
    const members = g.memberCodes.filter((c) => c !== own && known.has(c));
    const held = g.memberCodes.filter((c) => c !== own && heldPeople.has(c));
    const existing = match(g.label, groups);
    if (existing === 'skip') continue;
    if (existing) {
      const have = new Set(existing.memberCodes.map(normalizePairingCode));
      const fresh = [...new Set([...members, ...held])].filter((c) => !have.has(c));
      if (fresh.length === 0) continue;
      if (opts.topUp) {
        existing.memberCodes = [...existing.memberCodes, ...fresh];
        updatedGroups++;
      } else {
        topUps.push({ groupId: existing.id, label: existing.label, members: fresh.map(heldMember) });
      }
    } else if (members.length > 0) {
      const id = generateGroupId();
      groups.push({ id, label: g.label, memberCodes: [...new Set(members)] });
      createdGroupIds.push(id);
      addedGroups++;
      if (held.length > 0) topUps.push({ groupId: id, label: g.label, members: [...new Set(held)].map(heldMember) });
    } else if (held.length > 0) {
      topUps.push({ groupId: null, label: g.label, members: [...new Set(held)].map(heldMember) });
    }
  }
  return {
    partners,
    groups,
    addedPeople,
    addedGroups,
    updatedGroups,
    createdGroupIds,
    held: { topUps, clashes: [...heldPeople.values()] },
  };
}

/** Anything held? */
export function hasHeldChanges(h: HeldChanges): boolean {
  return h.topUps.length > 0 || h.clashes.length > 0;
}

/** Apply held changes the user said yes to: add the held people as
 *  contacts and the members to their groups (creating a group whose id is
 *  null, or whose group has since been deleted). Returns new lists plus
 *  the ids of groups it created. */
export function applyHeldChanges(opts: {
  held: HeldChanges;
  ownCode: string;
  partners: readonly PairingPartner[];
  groups: readonly PairingGroup[];
}): { partners: PairingPartner[]; groups: PairingGroup[]; createdGroupIds: string[] } {
  const own = normalizePairingCode(opts.ownCode);
  const partners = opts.partners.map((p) => ({ ...p }));
  const known = new Set(partners.map((p) => normalizePairingCode(p.code)));
  const addPerson = (m: HeldMember): void => {
    if (m.code === own || known.has(m.code)) return;
    partners.push({ code: m.code, name: m.name });
    known.add(m.code);
  };
  for (const m of opts.held.clashes) addPerson(m);
  const groups = opts.groups.map((g) => ({ ...g, memberCodes: [...g.memberCodes] }));
  const createdGroupIds: string[] = [];
  for (const t of opts.held.topUps) {
    for (const m of t.members) addPerson(m);
    const codes = t.members.map((m) => m.code).filter((c) => c !== own);
    let g = t.groupId ? groups.find((x) => x.id === t.groupId) : undefined;
    if (!g) g = groups.find((x) => x.label.toLowerCase() === t.label.toLowerCase());
    if (!g) {
      g = { id: generateGroupId(), label: t.label, memberCodes: [] };
      groups.push(g);
      createdGroupIds.push(g.id);
    }
    g.memberCodes = [...new Set([...g.memberCodes, ...codes])];
  }
  return { partners, groups, createdGroupIds };
}

/** The held changes as lines for a confirm: each person by name and short
 *  code, with a warning when the name is already one of your contacts. */
export function describeHeldChanges(h: HeldChanges): string[] {
  const who = (m: HeldMember): string =>
    `${m.name} (${shortPairingCode(m.code)})` +
    (m.clashesWith
      ? ` \u2014 \u26a0 same name as your contact \u201c${m.clashesWith.name}\u201d (${shortPairingCode(m.clashesWith.code)}) but a different code`
      : '');
  const lines: string[] = [];
  for (const t of h.topUps) {
    lines.push(`\u2022 add to ${t.groupId ? 'your group' : 'new group'} \u201c${t.label}\u201d: ${t.members.map(who).join(', ')}`);
  }
  const inGroups = new Set(h.topUps.flatMap((t) => t.members.map((m) => m.code)));
  for (const m of h.clashes) if (!inGroups.has(m.code)) lines.push(`\u2022 add contact ${who(m)}`);
  return lines;
}

/** The team file's raw JSON with `{ name, code }` appended to `people`, or
 *  null when the code is already listed (or `raw` isn't a team file). Every
 *  other field is kept exactly as it was — groups, relay, sessions, hand
 *  edits, anything a newer app wrote — since this rewrites a shared file. */
export function addPersonToTeamFileJson(
  raw: unknown,
  person: { code: string; name: string },
): Record<string, unknown> | null {
  if (!parseTeamFile(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const code = normalizePairingCode(person.code);
  const name = person.name.trim();
  if (!code || !name) return null;
  const people = Array.isArray(obj['people']) ? (obj['people'] as unknown[]) : [];
  const listed = people.some(
    (p) => typeof (p as { code?: unknown })?.code === 'string' && normalizePairingCode((p as { code: string }).code) === code,
  );
  if (listed) return null;
  return { ...obj, people: [...people, { name, code }] };
}

/** The team file's raw JSON with `teamKey` set, or null when it already
 *  has a valid one (never replaced) or `raw` isn't a team file. Every
 *  other field is kept as it was, like addPersonToTeamFileJson. */
export function addTeamKeyToTeamFileJson(raw: unknown, teamKey: string): Record<string, unknown> | null {
  const file = parseTeamFile(raw);
  if (!file || file.teamKey || !isTeamKey(teamKey)) return null;
  return { ...(raw as Record<string, unknown>), teamKey };
}
