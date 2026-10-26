/**
 * Team directory — the client side of the optional relay extension
 * "team directory v1" (reference-docs/relay-team-directory-v1.md).
 *
 * A relay can keep one shared team list per team (the team comes from the
 * bearer token): the team's name, its people (display name + send code),
 * its groups and its team key. This install offers to import it once, and
 * afterwards keeps in step with it.
 *
 * Importing behaves exactly like importing a team file (.cmteam): the
 * directory is turned into a TeamFile and merged with mergeTeamFile —
 * existing contacts keep their names, your own code is skipped, new groups
 * are added, and members for a group you already have wait for a yes
 * (team-review.ts) — and the team key follows the same
 * rule (mergeTeamKey: a local key is never silently replaced; a different
 * one gets the same quiet notice as a team file's).
 *
 * Strictly additive and quiet:
 *  - Only on a custom relay (Settings → Collaboration → Custom relay URL)
 *    with card sharing on. Nothing about any operator is built in.
 *  - Discovery 404 or any other error = unsupported: nothing new shown.
 *  - Nothing is sent before the user says Import. Registering then sends
 *    this install's own send code and display name — nothing else — and
 *    the team key only once the directory was imported.
 *  - Fetched on start, when Settings → Collaboration opens, and at most
 *    every 5 minutes, with If-None-Match on the last revision.
 *
 * Light module (no Loro, no DOM): the visible parts live in
 * team-directory-ui.ts.
 */

import { RoomsError, type RoomsClient } from './room-client.js';
import { settings, type PairingGroup, type PairingPartner, type TeamDirectoryRelayState } from '../settings.js';
import { normalizePairingCode } from '../pairing/pairing-ids.js';
import { mergeTeamFile, TEAM_FILE_KIND, type HeldChanges, type TeamFile, type TeamMergeResult } from '../pairing/team-file.js';
import { isTeamKey, mergeTeamKey } from '../pairing/team-key.js';
import { applyTeamKeyFromFile, ensureLocalTeamKey } from '../pairing/team-file-sync.js';
import { keyBelongsHere, noteTeamKeyOrigin, type TeamKeyOrigin } from './relay-profiles.js';
import { showToast } from '../toast.js';
import { tournamentModeOn } from '../tournament-mode.js';
import { relayMatchKey, tokenFingerprint } from '../relay-protocol.js';
import { relayTag, tagImported } from '../pairing/contact-relays.js';
import { queueTeamReview } from '../pairing/team-review.js';

/** Background refresh cadence: a conditional GET (usually a 304), so cheap enough that a teammate who joins mid-practice shows up within minutes. */
export const TEAM_DIRECTORY_REFRESH_MS = 5 * 60_000;
/** A forced refresh (settings opened) this close to the last one reuses it. */
const FORCE_FLOOR_MS = 5_000;
/** The spec caps a person's name at 60 characters. */
export const TEAM_DIRECTORY_NAME_MAX = 60;

export interface TeamDirectorySupport {
  v: 1;
  maxPeople: number;
  maxGroups: number;
}

export interface TeamDirectoryPerson {
  code: string;
  name: string;
  /** The person registered this entry themselves. */
  self: boolean;
}

export interface TeamDirectory {
  v: 1;
  name: string;
  people: TeamDirectoryPerson[];
  groups: { label: string; memberCodes: string[] }[];
  /** Groups teammates suggested (optional extension); never auto-imported. */
  suggestedGroups: { label: string; memberCodes: string[]; by: string[] }[];
  teamKey?: string;
  revision: number;
  updatedAt: number | null;
}

/** What a directory call needs: the relay client, its base URL and the
 *  bearer token (the team; only a fingerprint of it is ever stored). */
export interface TeamDirectoryContext {
  client: RoomsClient;
  baseUrl: string;
  token: string;
  /** Is this still the relay in Settings? A refresh that outlives a relay
   *  switch must not write its team's list, groups or key into the new
   *  relay's settings. Absent: always (tests, one-shot calls). */
  isCurrent?: () => boolean;
}

/** Still talking to the relay in Settings (see TeamDirectoryContext.isCurrent). */
const stillCurrent = (ctx: TeamDirectoryContext): boolean => ctx.isCurrent?.() ?? true;

/** The offer to show: "Your team (<name>) is set up on this relay." */
export interface TeamDirectoryOffer {
  key: string;
  directory: TeamDirectory;
  /** People this install doesn't have yet. */
  missing: number;
  /** This install is already on the list (by its send code). With nobody
   *  missing and not listed, the offer is "add yourself" (a new team's
   *  first members have nothing to import). */
  listed: boolean;
}

// --- parsing ----------------------------------------------------------

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** The discovery document, or null (= unsupported). */
export function parseTeamDirectorySupport(raw: unknown): TeamDirectorySupport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d);
  return { v: 1, maxPeople: n(r['maxPeople'], 200), maxGroups: n(r['maxGroups'], 50) };
}

/** Parse a relay's directory, dropping malformed entries (a person with
 *  no code, a group member who isn't listed, a malformed team key). Null
 *  when it isn't a v1 directory at all. */
export function parseTeamDirectory(raw: unknown): TeamDirectory | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  const people: TeamDirectoryPerson[] = [];
  const seen = new Set<string>();
  for (const p of Array.isArray(r['people']) ? r['people'] : []) {
    if (!p || typeof p !== 'object') continue;
    const e = p as Record<string, unknown>;
    const code = normalizePairingCode(str(e['code'], 2000));
    if (!code || seen.has(code)) continue;
    seen.add(code);
    people.push({ code, name: str(e['name'], TEAM_DIRECTORY_NAME_MAX), self: e['self'] === true });
  }
  const groups: TeamDirectory['groups'] = [];
  for (const g of Array.isArray(r['groups']) ? r['groups'] : []) {
    if (!g || typeof g !== 'object') continue;
    const e = g as Record<string, unknown>;
    const label = str(e['label'], 80);
    if (!label) continue;
    const members = (Array.isArray(e['members']) ? e['members'] : [])
      .map((m) => normalizePairingCode(str(m, 2000)))
      .filter((c) => seen.has(c));
    groups.push({ label, memberCodes: [...new Set(members)] });
  }
  const revision = typeof r['revision'] === 'number' && Number.isInteger(r['revision']) && r['revision'] >= 0 ? r['revision'] : 0;
  const updatedAt = typeof r['updatedAt'] === 'number' && Number.isFinite(r['updatedAt']) ? r['updatedAt'] : null;
  const suggestedGroups: TeamDirectory['suggestedGroups'] = [];
  for (const g of Array.isArray(r['suggestedGroups']) ? r['suggestedGroups'] : []) {
    if (!g || typeof g !== 'object') continue;
    const e = g as Record<string, unknown>;
    const label = str(e['label'], 80);
    const members = [
      ...new Set(
        (Array.isArray(e['members']) ? e['members'] : []).map((m) => normalizePairingCode(str(m, 2000))).filter((c) => seen.has(c)),
      ),
    ];
    if (!label || members.length < 2) continue;
    const by = (Array.isArray(e['by']) ? e['by'] : []).map((n) => str(n, TEAM_DIRECTORY_NAME_MAX)).filter(Boolean);
    suggestedGroups.push({ label, memberCodes: members, by });
  }
  const dir: TeamDirectory = { v: 1, name: str(r['name'], 80), people, groups, suggestedGroups, revision, updatedAt };
  if (isTeamKey(r['teamKey'])) dir.teamKey = r['teamKey'];
  return dir;
}

/** The directory as a team file, so importing it IS a team file import
 *  (same merge, same key rule, same notice). */
export function directoryAsTeamFile(dir: TeamDirectory): TeamFile {
  const file: TeamFile = {
    kind: TEAM_FILE_KIND,
    version: 1,
    name: dir.name || 'Team',
    people: dir.people.map((p) => ({ code: p.code, name: p.name })),
    groups: dir.groups.map((g) => ({ label: g.label, memberCodes: [...g.memberCodes] })),
  };
  if (dir.teamKey) file.teamKey = dir.teamKey;
  return file;
}

/** Merge the directory's people and groups into the importer's lists:
 *  the first time exactly as a team file (groups matched by name), after
 *  that only into the groups the list owns. Members for a group you
 *  already have are held (`held`), as a team file's are. */
export function mergeTeamDirectory(opts: {
  directory: TeamDirectory;
  ownCode: string;
  partners: readonly PairingPartner[];
  groups: readonly PairingGroup[];
  /** Groups this relay's list owns (TeamDirectoryRelayState.groupIds).
   *  Absent: matched by name like a team file, and recorded. */
  groupIds?: readonly string[];
}): TeamMergeResult & { groupIds: string[] } {
  const owned = opts.groupIds;
  const file = directoryAsTeamFile(opts.directory);
  if (!owned) {
    const merged = mergeTeamFile({ file, ownCode: opts.ownCode, partners: opts.partners, groups: opts.groups });
    const labels = new Set(opts.directory.groups.map((g) => g.label.toLowerCase()));
    return { ...merged, groupIds: merged.groups.filter((g) => labels.has(g.label.toLowerCase())).map((g) => g.id) };
  }
  // Groups only into the ones this list made, so a group of yours with
  // the same name never gains its members (nor is a second one made).
  const ids = new Set(owned.filter((id) => opts.groups.some((g) => g.id === id)));
  const merged = mergeTeamFile({
    file,
    ownCode: opts.ownCode,
    partners: opts.partners,
    groups: opts.groups,
    match: (label, groups) => {
      const l = label.toLowerCase();
      const mine = groups.find((x) => ids.has(x.id) && x.label.toLowerCase() === l);
      if (mine) return mine;
      return groups.some((x) => x.label.toLowerCase() === l) ? 'skip' : null;
    },
  });
  for (const id of merged.createdGroupIds) ids.add(id);
  return { ...merged, groupIds: [...ids] };
}

/** How many of the directory's people this install doesn't have (its own
 *  code never counts). */
export function missingPeople(dir: TeamDirectory, ownCode: string, partners: readonly PairingPartner[]): number {
  const own = normalizePairingCode(ownCode);
  const known = new Set(partners.map((p) => normalizePairingCode(p.code)));
  return dir.people.filter((p) => p.code !== own && !known.has(p.code)).length;
}

/** Is this install on the list? (Only a valid send code can be.) */
export function isListed(dir: TeamDirectory, ownCode: string): boolean {
  const own = normalizePairingCode(ownCode);
  return dir.people.some((p) => p.code === own);
}

/** Offer the import? Not once imported, not on the revision the user said
 *  "Not now" to; then when someone is missing, or when this install (with
 *  a send code) isn't listed yet, so the first teammates can add themselves. */
export function shouldOffer(
  dir: TeamDirectory,
  state: Pick<TeamDirectoryRelayState, 'imported' | 'dismissedRevision'>,
  ownCode: string,
  partners: readonly PairingPartner[],
): boolean {
  if (state.imported || state.dismissedRevision === dir.revision) return false;
  if (missingPeople(dir, ownCode, partners) > 0) return true;
  return isDirectorySendCode(normalizePairingCode(ownCode)) && !isListed(dir, ownCode);
}

// --- per relay + team state (settings.teamDirectoryRelays) -------------

export { tokenFingerprint };

/** Per relay + team: the same key saved relays use (relay-protocol.ts). */
export function directoryKey(baseUrl: string, token: string): string {
  return relayMatchKey(baseUrl, token);
}

const blankState = (key: string): TeamDirectoryRelayState => ({
  key,
  imported: false,
  dismissedRevision: -1,
  revision: -1,
  hasKey: false,
});

export function directoryState(key: string): TeamDirectoryRelayState {
  return settings.get('teamDirectoryRelays').find((s) => s.key === key) ?? blankState(key);
}

function patchState(key: string, patch: Partial<Omit<TeamDirectoryRelayState, 'key'>>): TeamDirectoryRelayState {
  const all = settings.get('teamDirectoryRelays');
  const next = { ...directoryState(key), ...patch, key };
  const prev = all.find((s) => s.key === key);
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return next;
  settings.set('teamDirectoryRelays', [...all.filter((s) => s.key !== key), next].slice(-20));
  return next;
}

/** "Not now": hide the offer for this relay + team until the revision changes. */
export function dismissOffer(key: string, revision: number): void {
  patchState(key, { dismissedRevision: revision });
  if (offer?.key === key) publishOffer(null);
}

// --- discovery --------------------------------------------------------

const discovery = new Map<string, Promise<TeamDirectorySupport | null>>();

/** Does the relay at `baseUrl` support the extension? Cached per base URL
 *  (and token) for the app run; a network failure is not cached. */
export function teamDirectorySupport(ctx: TeamDirectoryContext): Promise<TeamDirectorySupport | null> {
  const key = directoryKey(ctx.baseUrl, ctx.token);
  const hit = discovery.get(key);
  if (hit) return hit;
  const p = ctx.client.teamDirectoryInfo().then(parseTeamDirectorySupport, (err): null => {
    if (err instanceof RoomsError && err.status === 0) discovery.delete(key);
    return null;
  });
  discovery.set(key, p);
  return p;
}

// --- the offer --------------------------------------------------------

let offer: TeamDirectoryOffer | null = null;
const offerListeners = new Set<(o: TeamDirectoryOffer | null) => void>();

export function currentOffer(): TeamDirectoryOffer | null {
  return offer;
}

/** Called with the offer whenever it changes (null = take it down). */
export function onTeamDirectoryOffer(fn: (o: TeamDirectoryOffer | null) => void): () => void {
  offerListeners.add(fn);
  return () => offerListeners.delete(fn);
}

function publishOffer(next: TeamDirectoryOffer | null): void {
  const same =
    (offer === null && next === null) ||
    (!!offer &&
      !!next &&
      offer.key === next.key &&
      offer.directory.revision === next.directory.revision &&
      offer.missing === next.missing &&
      offer.listed === next.listed);
  offer = next;
  if (!same) for (const fn of offerListeners) fn(next);
}

// --- team key ---------------------------------------------------------

/** Give the team this machine's key when the directory has none (minting
 *  one when this machine has none either); on 409 take the team's — a key
 *  minted just now gives way, an older one follows the merge rule (never
 *  replaced: the same notice as a team file's). A key saved for a
 *  different team's relay is never sent. Never throws. */
export async function syncTeamKeyUp(ctx: TeamDirectoryContext, key: string, teamName: string): Promise<void> {
  let local = settings.get('teamSessionsKey');
  const minted = !isTeamKey(local);
  if (minted) local = ensureLocalTeamKey();
  else if (!keyBelongsHere(local)) return;
  try {
    const existing = await ctx.client.putTeamDirectoryKey(local);
    patchState(key, { hasKey: true });
    if (!stillCurrent(ctx)) return;
    if (existing !== null && isTeamKey(existing) && minted && existing !== local) {
      settings.set('teamSessionsKey', existing);
      noteTeamKeyOrigin(existing, fromThisRelay());
      return;
    }
    // 409: someone else's key won the race. Same rule as a team file's.
    if (existing !== null && isTeamKey(existing) && mergeTeamKey(local, existing).conflict) {
      applyTeamKeyFromFile({ kind: TEAM_FILE_KIND, version: 1, name: teamName || 'Team', people: [], groups: [], teamKey: existing }, fromThisRelay());
    }
  } catch {
    /* offline or refused: try again next refresh */
  }
}

/** The directory's team key, under the team file rule — except that a key
 *  this machine holds for a different team's relay gives way to it. */
function takeDirectoryKey(dir: TeamDirectory): void {
  const local = settings.get('teamSessionsKey');
  if (dir.teamKey && isTeamKey(local) && local !== dir.teamKey && !keyBelongsHere(local)) {
    settings.set('teamSessionsKey', dir.teamKey);
    noteTeamKeyOrigin(dir.teamKey, fromThisRelay());
    return;
  }
  applyTeamKeyFromFile(directoryAsTeamFile(dir), fromThisRelay());
}

/** A key taken from the team list of the relay in Settings (callers have
 *  checked the refresh is still current). */
function fromThisRelay(): TeamKeyOrigin {
  return { relay: { url: settings.get('pairingRelayUrl'), token: settings.get('pairingRelayToken') } };
}

// --- refresh ----------------------------------------------------------

const memory = new Map<string, TeamDirectory>();
const fetchedAt = new Map<string, number>();
const inflight = new Map<string, Promise<TeamDirectory | null>>();

export type ApplyResult = { addedPeople: number; addedGroups: number };

/** Offer what the list held back (members for a group you already have,
 *  a new person named like one of your contacts) — team-review.ts; a yes
 *  tags the people as on this relay and records any group it made as
 *  the list's. */
function queueDirectoryReview(dir: TeamDirectory, key: string, held: HeldChanges, tag: string): void {
  queueTeamReview({
    source: `dir:${key}`,
    teamName: dir.name.trim() || 'your relay\u2019s team',
    held,
    sessions: [],
    onAccept: (created, before) => {
      settings.set('pairingPartners', tagImported(settings.get('pairingPartners'), before, dir.people.map((p) => p.code), tag));
      if (created.length > 0) patchState(key, { groupIds: [...(directoryState(key).groupIds ?? []), ...created] });
    },
  });
}

/** Merge silently (an imported directory): new people every time (the
 *  list is the team); new groups and relay tags only when the list
 *  changed (members for a group you have are offered, not added),
 *  so a member you took out of a group or a relay you unticked for a
 *  contact stays that way until the team's list moves. Toasts "Added N
 *  teammates from your relay" when N > 0. */
function applyImported(dir: TeamDirectory, tag: string, key: string): ApplyResult {
  const before = settings.get('pairingPartners');
  const state = directoryState(key);
  const changed = state.mergedRevision !== dir.revision;
  const merged = mergeTeamDirectory({
    directory: changed ? dir : { ...dir, groups: [] },
    ownCode: settings.get('pairingOwnCode'),
    partners: before,
    groups: settings.get('pairingGroups'),
    groupIds: state.groupIds,
  });
  // Everyone on this relay's list is on this relay (contact-relays.ts).
  const tagged = tagImported(merged.partners, before, dir.people.map((p) => p.code), tag, { retag: changed });
  if (merged.addedPeople || merged.addedGroups || JSON.stringify(tagged) !== JSON.stringify(before)) {
    settings.set('pairingPartners', tagged);
    settings.set('pairingGroups', merged.groups);
  }
  if (changed) patchState(key, { mergedRevision: dir.revision, groupIds: merged.groupIds });
  takeDirectoryKey(dir);
  if (merged.addedPeople > 0 && !tournamentModeOn()) {
    showToast(`Added ${merged.addedPeople} teammate${merged.addedPeople === 1 ? '' : 's'} from your relay.`);
  }
  if (changed) queueDirectoryReview(dir, key, merged.held, tag);
  return { addedPeople: merged.addedPeople, addedGroups: merged.addedGroups };
}

/** Fetch the directory for `ctx` (`force`: settings opened; else at most
 *  every 5 minutes) and act on it: merge if imported, else offer. A null ctx (no
 *  custom relay, or card sharing off) takes the offer down. Never throws;
 *  resolves the directory in hand (null = none / unsupported). */
export async function refreshTeamDirectory(
  ctx: TeamDirectoryContext | null,
  opts: { force?: boolean; now?: number } = {},
): Promise<TeamDirectory | null> {
  if (!ctx) {
    publishOffer(null);
    return null;
  }
  const key = directoryKey(ctx.baseUrl, ctx.token);
  const now = opts.now ?? Date.now();
  const last = fetchedAt.get(key);
  if (last !== undefined && now - last < (opts.force ? FORCE_FLOOR_MS : TEAM_DIRECTORY_REFRESH_MS)) {
    return memory.get(key) ?? null;
  }
  const running = inflight.get(key);
  if (running) return running;
  const p = runRefresh(ctx, key, now);
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

async function runRefresh(ctx: TeamDirectoryContext, key: string, now: number): Promise<TeamDirectory | null> {
  if (offer && offer.key !== key) publishOffer(null);
  const supported = await teamDirectorySupport(ctx);
  if (!stillCurrent(ctx)) return null;
  if (!supported) {
    publishOffer(null);
    return null;
  }
  fetchedAt.set(key, now);
  const st = directoryState(key);
  const cached = memory.get(key) ?? null;
  // Ask "changed since?" only with that revision in hand: an imported team
  // re-merges the list on every refresh (below), so it needs the list
  // itself, not just "unchanged" (after a restart, memory is empty).
  const conditional = st.revision >= 0 && cached?.revision === st.revision;
  let raw: unknown;
  try {
    raw = await ctx.client.getTeamDirectory(conditional ? st.revision : undefined);
  } catch (err) {
    if (!stillCurrent(ctx)) return null;
    if (!(err instanceof RoomsError && err.status === 0)) publishOffer(null);
    else fetchedAt.delete(key); // offline: ask again next time
    return cached;
  }
  // Switched relays while this was in flight: the list is still that
  // relay's (stored under its own key), but nothing of it is applied here.
  if (!stillCurrent(ctx)) return null;
  let dir: TeamDirectory | null;
  if (raw === null) {
    dir = cached;
  } else {
    dir = parseTeamDirectory(raw);
    if (!dir) {
      publishOffer(null);
      return null;
    }
    memory.set(key, dir);
    patchState(key, { revision: dir.revision, hasKey: !!dir.teamKey });
  }

  let state = directoryState(key);
  // Auto-add: on a relay with a team list, join it and add everyone, no
  // click (it's your own team's relay). Only a missing display name stops
  // it: then the Send popup's line asks for one.
  if (!state.imported && dir && settings.get('pairingDisplayName').trim() && ownDirectoryEntry()) {
    const out = await importTeamDirectory(ctx, dir, settings.get('pairingDisplayName'));
    if (!stillCurrent(ctx)) return null;
    if (out.ok) {
      const team = dir.name.trim() || 'your team';
      showToast(
        out.addedPeople > 0
          ? `Added ${out.addedPeople} teammate${out.addedPeople === 1 ? '' : 's'} from ${team}.`
          : `You’re on ${team}’s list on this relay.`,
      );
      state = directoryState(key);
    }
  }
  if (state.imported) {
    publishOffer(null);
    // Every refresh, changed or not: the list is the team, so a teammate
    // deleted here comes back (hide them in the Send pill instead, or ask
    // whoever manages the team to take them off the list).
    if (dir) applyImported(dir, relayTag(ctx.baseUrl), key);
    const relayHasKey = dir ? !!dir.teamKey : state.hasKey;
    if (!relayHasKey) await syncTeamKeyUp(ctx, key, dir?.name ?? '');
    if (!stillCurrent(ctx)) return null;
    if (dir) {
      await syncMyGroups(ctx, key, dir);
      if (!stillCurrent(ctx)) return null;
      publishSuggestions(key, dir);
    }
    return dir;
  }
  if (dir && shouldOffer(dir, state, settings.get('pairingOwnCode'), settings.get('pairingPartners'))) {
    const own = settings.get('pairingOwnCode');
    publishOffer({ key, directory: dir, missing: missingPeople(dir, own, settings.get('pairingPartners')), listed: isListed(dir, own) });
  } else {
    publishOffer(null);
  }
  return dir;
}

// --- suggested groups (optional extension) ----------------------------

/** Signature of the groups last suggested per relay + team this app run. */
const lastGroupsSent = new Map<string, string>();
/** Relays + teams that answered the groups PUT with "not here" (404). */
const noSuggestions = new Set<string>();

/** Your groups made only of teammates on this list (2+ of them): what you
 *  suggest to the team. Groups with anyone else stay private. */
export function myTeamGroups(dir: TeamDirectory, groups: readonly PairingGroup[], ownCode: string): { label: string; members: string[] }[] {
  const codes = new Set(dir.people.map((p) => p.code));
  const own = normalizePairingCode(ownCode);
  const official = new Set(dir.groups.map((g) => groupSig(g.label, g.memberCodes)));
  return groups
    .map((g) => ({ label: g.label.trim(), members: [...new Set(g.memberCodes.map(normalizePairingCode))] }))
    .filter((g) => g.label && g.members.length >= 2 && g.members.every((c) => codes.has(c) || c === own))
    .filter((g) => !official.has(groupSig(g.label, g.members)))
    .slice(0, 20);
}

const groupSig = (label: string, members: readonly string[]): string =>
  `${label.trim().toLowerCase()}\n${[...members].map(normalizePairingCode).sort().join(',')}`;

/** Suggest your team groups (only on a change). Never throws. */
export async function syncMyGroups(ctx: TeamDirectoryContext, key: string, dir: TeamDirectory): Promise<void> {
  const me = ownDirectoryEntry();
  if (!me || noSuggestions.has(key) || !isListed(dir, me.code)) return;
  const mine = myTeamGroups(dir, settings.get('pairingGroups'), me.code);
  const sig = JSON.stringify(mine);
  // Nothing to suggest and nothing suggested yet this run: no call.
  if ((lastGroupsSent.get(key) ?? '[]') === sig) return;
  try {
    await ctx.client.putTeamDirectoryGroups(me.code, mine);
    lastGroupsSent.set(key, sig);
  } catch (err) {
    if (err instanceof RoomsError && err.status === 404) noSuggestions.add(key);
  }
}

/** The suggestions worth showing: not one of your groups already, and not
 *  only your own. */
export function suggestionsToShow(dir: TeamDirectory, groups: readonly PairingGroup[], ownName: string): TeamDirectory['suggestedGroups'] {
  const have = new Set(groups.map((g) => groupSig(g.label, g.memberCodes)));
  const me = ownName.trim();
  return dir.suggestedGroups.filter((g) => !have.has(groupSig(g.label, g.memberCodes)) && !(g.by.length === 1 && g.by[0] === me));
}

let suggestions: { key: string; groups: TeamDirectory['suggestedGroups'] } | null = null;
const suggestionListeners = new Set<() => void>();

export function currentSuggestions(): TeamDirectory['suggestedGroups'] {
  return suggestions?.groups ?? [];
}

export function onSuggestions(fn: () => void): () => void {
  suggestionListeners.add(fn);
  return () => suggestionListeners.delete(fn);
}

function publishSuggestions(key: string, dir: TeamDirectory | null): void {
  const next = dir ? suggestionsToShow(dir, settings.get('pairingGroups'), settings.get('pairingDisplayName')) : [];
  const same = suggestions?.key === key && JSON.stringify(suggestions.groups) === JSON.stringify(next);
  suggestions = { key, groups: next };
  if (!same) for (const fn of suggestionListeners) fn();
}

/** Your groups changed: re-suggest them and refresh what's shown. Never throws. */
export async function groupsChanged(ctx: TeamDirectoryContext | null): Promise<void> {
  if (!ctx) return;
  const key = directoryKey(ctx.baseUrl, ctx.token);
  const dir = memory.get(key);
  if (!dir || !directoryState(key).imported) return;
  await syncMyGroups(ctx, key, dir);
  publishSuggestions(key, dir);
}

/** Add a suggested group as your own (members you have as contacts). */
export function addSuggestedGroup(g: { label: string; memberCodes: string[] }): boolean {
  const partners = new Set(settings.get('pairingPartners').map((p) => normalizePairingCode(p.code)));
  const own = normalizePairingCode(settings.get('pairingOwnCode'));
  const members = g.memberCodes.filter((c) => partners.has(c) && c !== own);
  if (members.length === 0) return false;
  const groups = settings.get('pairingGroups');
  const taken = new Set(groups.map((x) => x.label.trim().toLowerCase()));
  let label = g.label.trim();
  for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${g.label.trim()} (${n})`;
  settings.set('pairingGroups', [...groups, { id: `grp-${Math.random().toString(36).slice(2, 10)}`, label, memberCodes: members }]);
  if (suggestions) publishSuggestions(suggestions.key, memory.get(suggestions.key) ?? null);
  return true;
}

// --- import + own entry -----------------------------------------------

/** The (code, name) last registered per relay + team this app run, so a
 *  settings change that doesn't touch either sends nothing. */
const lastSent = new Map<string, string>();

/** A send code as the relay accepts it (after trimming; case kept). */
export function isDirectorySendCode(code: string): boolean {
  return /^cmk1\.[A-Za-z0-9_-]{43}$/.test(code);
}

/** This install's own entry: its send code and display name (≤ 60
 *  characters), or null when it has no code or no name yet. */
export function ownDirectoryEntry(): { code: string; name: string } | null {
  const code = normalizePairingCode(settings.get('pairingOwnCode'));
  const name = settings.get('pairingDisplayName').trim().slice(0, TEAM_DIRECTORY_NAME_MAX).trim();
  if (!isDirectorySendCode(code) || !name) return null;
  return { code, name };
}

export type ImportOutcome =
  | { ok: true; addedPeople: number; addedGroups: number }
  | { ok: false; reason: 'no-name' | 'no-code' | 'not-connected' | 'failed' };

/** How to get past the relay's "open card sharing first" 409 (the relay
 *  registers only an install whose mailbox it has seen on this token):
 *  connect the mailbox (desktop: poll now), wait, then try once more. */
export interface RegisterRetry {
  connectMailbox?: () => Promise<void>;
  delayMs?: number;
}

const isNotConnected = (err: unknown): boolean => err instanceof RoomsError && err.status === 409;

/** PUT /team-directory/me, retried once after connecting the mailbox on
 *  the relay's 409. Throws the last error. */
async function registerMe(ctx: TeamDirectoryContext, me: { code: string; name: string }, retry: RegisterRetry): Promise<void> {
  try {
    await ctx.client.putTeamDirectoryMe(me.code, me.name);
  } catch (err) {
    if (!isNotConnected(err)) throw err;
    try {
      await retry.connectMailbox?.();
    } catch {
      /* the retry says whether it worked */
    }
    await new Promise((r) => setTimeout(r, retry.delayMs ?? 3000));
    await ctx.client.putTeamDirectoryMe(me.code, me.name);
  }
}

/** Import (the user said yes and confirmed `name`): save the display
 *  name, register this install with PUT /team-directory/me, then merge
 *  people, groups and the team key exactly as a team file import does. */
export async function importTeamDirectory(
  ctx: TeamDirectoryContext,
  dir: TeamDirectory,
  name: string,
  retry: RegisterRetry = {},
): Promise<ImportOutcome> {
  const key = directoryKey(ctx.baseUrl, ctx.token);
  const typed = name.trim();
  if (typed && typed !== settings.get('pairingDisplayName').trim()) {
    // Mark it sent first: the name-change watcher must not PUT it twice.
    const code = normalizePairingCode(settings.get('pairingOwnCode'));
    lastSent.set(key, `${code}\n${typed.slice(0, TEAM_DIRECTORY_NAME_MAX).trim()}`);
    settings.set('pairingDisplayName', typed);
  }
  if (!settings.get('pairingDisplayName').trim()) return { ok: false, reason: 'no-name' };
  const me = ownDirectoryEntry();
  if (!me) return { ok: false, reason: 'no-code' };
  try {
    await registerMe(ctx, me, retry);
  } catch (err) {
    lastSent.delete(key);
    return { ok: false, reason: isNotConnected(err) ? 'not-connected' : 'failed' };
  }
  lastSent.set(key, `${me.code}\n${me.name}`);
  // Registered on that relay, but the user has since switched: merging now
  // would put that team's people and key under the new relay.
  if (!stillCurrent(ctx)) return { ok: false, reason: 'failed' };
  const before = settings.get('pairingPartners');
  const merged = mergeTeamDirectory({
    directory: dir,
    ownCode: settings.get('pairingOwnCode'),
    partners: before,
    groups: settings.get('pairingGroups'),
    groupIds: directoryState(key).groupIds,
  });
  settings.set('pairingPartners', tagImported(merged.partners, before, dir.people.map((p) => p.code), relayTag(ctx.baseUrl)));
  settings.set('pairingGroups', merged.groups);
  // Team key: taken when this machine has none; a different one never
  // replaces yours (the team file's quiet notice instead).
  takeDirectoryKey(dir);
  // The revision stays the one merged: the next fetch gets the whole
  // directory again (our own entry, and anything a manager changed in
  // between), and merging it twice is a no-op.
  patchState(key, { imported: true, revision: dir.revision, hasKey: !!dir.teamKey, mergedRevision: dir.revision, groupIds: merged.groupIds });
  queueDirectoryReview(dir, key, merged.held, relayTag(ctx.baseUrl));
  publishOffer(null);
  if (!dir.teamKey) await syncTeamKeyUp(ctx, key, dir.name);
  return { ok: true, addedPeople: merged.addedPeople, addedGroups: merged.addedGroups };
}

/** Re-register this install's entry after its display name (or code)
 *  changed — only on a relay + team it was imported from. Resolves true
 *  when a PUT was sent and accepted. Never throws. */
export async function updateOwnEntry(ctx: TeamDirectoryContext, retry: RegisterRetry = {}): Promise<boolean> {
  const key = directoryKey(ctx.baseUrl, ctx.token);
  if (!directoryState(key).imported) return false;
  const me = ownDirectoryEntry();
  if (!me) return false;
  const sig = `${me.code}\n${me.name}`;
  if (lastSent.get(key) === sig) return false;
  try {
    lastSent.set(key, sig);
    await registerMe(ctx, me, retry);
    return true;
  } catch {
    lastSent.delete(key);
    return false;
  }
}

/** Test hook: reset module state between cases. */
export function __resetTeamDirectoryForTests(): void {
  discovery.clear();
  memory.clear();
  fetchedAt.clear();
  inflight.clear();
  lastSent.clear();
  lastGroupsSent.clear();
  noSuggestions.clear();
  suggestions = null;
  suggestionListeners.clear();
  offer = null;
  offerListeners.clear();
}
