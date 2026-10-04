/**
 * Team file — share a squad's send codes, groups, relay and live
 * collaboration sessions in one file, so nobody pastes codes by hand.
 *
 * A coach (or anyone) exports it from Settings → Collaboration; everyone
 * else imports it. Import MERGES: people are added by code (an existing
 * contact keeps its name; the importer's own code is skipped), groups are
 * matched by name and gain any missing members, and the relay / sessions
 * apply only when the importer agrees. Nothing the importer had is lost.
 *
 * The file is plain JSON meant to be editable by hand: people are
 * `{ "name", "code" }`, and groups list their members BY NAME
 * (`"members": ["Ana Lopez", "Ben Wu"]`), so moving someone between groups
 * is a one-line edit. (Older files listing `memberCodes` still import.)
 *
 * Pure module (no settings / DOM): build + merge + parse, unit-tested.
 */
import type { PairingGroup, PairingPartner } from '../settings.js';
import { generateGroupId, normalizePairingCode } from './pairing-ids.js';

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
}

export function buildTeamFile(opts: {
  name: string;
  ownCode: string;
  ownName: string;
  partners: readonly PairingPartner[];
  groups: readonly PairingGroup[];
  relay?: { url: string; token: string } | null;
  sessions?: readonly TeamFileSession[];
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
  return file;
}

export interface TeamMergeResult {
  partners: PairingPartner[];
  groups: PairingGroup[];
  addedPeople: number;
  addedGroups: number;
  updatedGroups: number;
}

/** Merge a team file's people and groups into the importer's own lists. */
export function mergeTeamFile(opts: {
  file: TeamFile;
  ownCode: string;
  partners: readonly PairingPartner[];
  groups: readonly PairingGroup[];
}): TeamMergeResult {
  const own = normalizePairingCode(opts.ownCode);
  const partners = opts.partners.map((p) => ({ ...p }));
  const known = new Set(partners.map((p) => normalizePairingCode(p.code)));
  let addedPeople = 0;
  for (const p of opts.file.people) {
    if (p.code === own || known.has(p.code)) continue;
    partners.push({ code: p.code, name: p.name || p.code.slice(0, 12) });
    known.add(p.code);
    addedPeople++;
  }
  const groups = opts.groups.map((g) => ({ ...g, memberCodes: [...g.memberCodes] }));
  let addedGroups = 0;
  let updatedGroups = 0;
  for (const g of opts.file.groups) {
    // The importer's own code is a member of their team's group too, but
    // you don't send to yourself — leave it out.
    const members = g.memberCodes.filter((c) => c !== own && known.has(c));
    const existing = groups.find((x) => x.label.toLowerCase() === g.label.toLowerCase());
    if (existing) {
      const before = existing.memberCodes.length;
      existing.memberCodes = [...new Set([...existing.memberCodes, ...members])];
      if (existing.memberCodes.length > before) updatedGroups++;
    } else if (members.length > 0) {
      groups.push({ id: generateGroupId(), label: g.label, memberCodes: members });
      addedGroups++;
    }
  }
  return { partners, groups, addedPeople, addedGroups, updatedGroups };
}
