/**
 * Saved relays — switch between custom relays in one click.
 *
 * Someone who coaches a team on that team's relay and competes on their
 * own team's relay keeps both: every custom relay this install connects
 * to successfully is saved (URL, token, label, last used) together with
 * its own team key. Switching sets the custom relay URL + token, swaps
 * `teamSessionsKey` to the target's key (saving the outgoing relay's key
 * first, so no key is ever lost), and leaves any live co-editing session
 * first, on the user's say-so. Everything that reads the relay settings
 * live (the mailbox config push, the rooms client, relay info, the team
 * directory) follows by itself; the switch also nudges them.
 *
 * - Contacts and groups stay global: send codes belong to the install,
 *   not the relay.
 * - Team directory state is per relay + token already (teamDirectoryRelays,
 *   keyed by the same relayMatchKey), so each saved relay has its own;
 *   removing a saved relay drops it too.
 * - The built-in relay (account path) is untouched: "Built-in relay" in
 *   the list just clears the custom URL + token, keeping the saved ones,
 *   and restores the team key that was active there.
 * - Nothing about any operator is built in: a saved relay's default label
 *   comes from the relay's own info document, else its address.
 *
 * Light module (no DOM): the list in Settings and the status-bar menu live
 * in relay-profiles-ui.ts.
 */

import { settings, MAX_RELAY_PROFILES, type RelayProfile } from '../settings.js';
import { relayMatchKey } from '../relay-protocol.js';
import type { RelayInfo } from './relay-info.js';

export const BUILTIN_RELAY = 'builtin';

const normUrl = (url: string): string => url.trim().replace(/\/+$/, '');

/** "relay.example/relay" — host + path, for labels and the list. */
export function relayHostPath(url: string): string {
  try {
    const u = new URL(normUrl(url));
    const path = u.pathname.replace(/\/+$/, '');
    return u.host + (path && path !== '/' ? path : '');
  } catch {
    return normUrl(url);
  }
}

/** The label a relay gets until the user renames it: the team's own part
 *  of a per-team address (".../r/<name>" -> "<name>"), else the relay's
 *  operator name and access label when it says them, else its address. */
export function defaultRelayLabel(url: string, info: RelayInfo | null = null): string {
  let team = '';
  try {
    team = decodeURIComponent(/\/r\/([^/]+)\/?$/.exec(new URL(normUrl(url)).pathname)?.[1] ?? '');
  } catch {
    /* not a URL: fall through */
  }
  if (team.trim()) return team.trim().slice(0, 80);
  const parts = [info?.operator?.name ?? '', info?.access?.label ?? ''].map((s) => s.trim()).filter(Boolean);
  return (parts.length ? parts.join(' · ') : relayHostPath(url)).slice(0, 80);
}

/** A per-team address (".../r/<name>"): one team, whatever its token. A
 *  shared address (one relay, a team per token) is not. */
export function isTeamAddress(url: string): boolean {
  try {
    return /\/r\/[^/]+\/?$/.test(new URL(normUrl(url)).pathname);
  } catch {
    return false;
  }
}

/** Are two relay + token pairs the same team? The same token at the same
 *  address, or any token at the same per-team address (a rotated token). */
export function sameTeam(a: Pick<RelayProfile, 'url' | 'token'>, b: Pick<RelayProfile, 'url' | 'token'>): boolean {
  if (profileKey(a) === profileKey(b)) return true;
  return normUrl(a.url) === normUrl(b.url) && isTeamAddress(a.url);
}

export function profileKey(p: Pick<RelayProfile, 'url' | 'token'>): string {
  return relayMatchKey(p.url, p.token);
}

export function findProfile(
  list: readonly RelayProfile[],
  url: string,
  token: string,
): RelayProfile | null {
  if (!normUrl(url)) return null;
  const key = relayMatchKey(url, token);
  return list.find((p) => profileKey(p) === key) ?? null;
}

/** The saved relay in use now, or null (built-in, or a custom relay not
 *  saved yet). */
export function activeProfile(): RelayProfile | null {
  return findProfile(settings.get('relayProfiles'), settings.get('pairingRelayUrl'), settings.get('pairingRelayToken'));
}

/** What the current relay is called: a saved relay's label, the built-in
 *  relay, or the address of an unsaved custom one. */
export function currentRelayLabel(): string {
  const url = settings.get('pairingRelayUrl').trim();
  if (!url) return 'Built-in relay';
  return activeProfile()?.label || relayHostPath(url);
}

function newId(): string {
  const raw = new Uint8Array(6);
  crypto.getRandomValues(raw);
  return 'rp-' + [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function save(list: RelayProfile[]): void {
  // Newest use first is the list's order on screen; storage keeps insertion
  // order and drops the least recently used past the cap.
  let next = list;
  if (next.length > MAX_RELAY_PROFILES) {
    const drop = [...next].sort((a, b) => a.lastUsed - b.lastUsed).slice(0, next.length - MAX_RELAY_PROFILES);
    next = next.filter((p) => !drop.includes(p));
  }
  settings.set('relayProfiles', next);
}

/** The current custom relay connected: save it (first time) or update it
 *  (last used; the relay's own name unless renamed; the active team key).
 *  Null on the built-in relay. */
export function rememberConnectedRelay(opts: { info?: RelayInfo | null; now?: number } = {}): RelayProfile | null {
  const url = normUrl(settings.get('pairingRelayUrl'));
  if (!url) return null;
  const token = settings.get('pairingRelayToken');
  const now = opts.now ?? Date.now();
  const list = settings.get('relayProfiles');
  // A new token for a saved per-team address (".../r/<name>": the token was
  // rotated, or a teammate sent the current one) updates that relay instead
  // of saving a second one. On a shared address the token is the team, so
  // a new token is a new relay.
  const hit = findProfile(list, url, token) ?? list.find((p) => sameTeam(p, { url, token })) ?? null;
  const label = (p: RelayProfile | null): string =>
    p?.labelCustom ? p.label : opts.info ? defaultRelayLabel(url, opts.info) : p?.label || defaultRelayLabel(url);
  const next: RelayProfile = {
    id: hit?.id ?? newId(),
    label: label(hit),
    labelCustom: hit?.labelCustom ?? false,
    url,
    token,
    // The active relay's key is teamSessionsKey.
    teamKey: settings.get('teamSessionsKey'),
    lastUsed: now,
  };
  save(hit ? list.map((p) => (p.id === hit.id ? next : p)) : [...list, next]);
  // Same team under the new token: its team directory state (imported,
  // dismissed) moves along, so syncing carries on without a new offer.
  if (hit && profileKey(hit) !== profileKey(next)) {
    const from = profileKey(hit);
    const to = profileKey(next);
    const dirs = settings.get('teamDirectoryRelays');
    if (dirs.some((d) => d.key === from) && !dirs.some((d) => d.key === to)) {
      settings.set('teamDirectoryRelays', dirs.map((d) => (d.key === from ? { ...d, key: to } : d)));
    }
  }
  return next;
}

/** The relay's info arrived: a saved relay the user hasn't renamed takes
 *  the relay's own name. */
export function relabelFromInfo(info: RelayInfo | null): void {
  const hit = activeProfile();
  if (!hit || hit.labelCustom || !info) return;
  const label = defaultRelayLabel(hit.url, info);
  if (label !== hit.label) save(settings.get('relayProfiles').map((p) => (p.id === hit.id ? { ...p, label } : p)));
}

/** Rename; an empty name goes back to the default label. */
export function renameProfile(id: string, label: string, info: RelayInfo | null = null): void {
  const name = label.trim().slice(0, 80);
  save(
    settings.get('relayProfiles').map((p) =>
      p.id !== id ? p : name ? { ...p, label: name, labelCustom: true } : { ...p, label: defaultRelayLabel(p.url, info), labelCustom: false },
    ),
  );
}

/** Forget a saved relay (not the one in use: switch away first) and its
 *  team directory state. Resolves false when refused. */
export function removeProfile(id: string): boolean {
  const p = settings.get('relayProfiles').find((x) => x.id === id);
  if (!p || activeProfile()?.id === id) return false;
  save(settings.get('relayProfiles').filter((x) => x.id !== id));
  const key = profileKey(p);
  const dir = settings.get('teamDirectoryRelays');
  if (dir.some((s) => s.key === key)) settings.set('teamDirectoryRelays', dir.filter((s) => s.key !== key));
  return true;
}

// --- switching --------------------------------------------------------

/** Set while a switch writes settings, so the manual-edit watcher doesn't
 *  treat the switch as an edit. */
let switching = false;

export function isSwitchingRelay(): boolean {
  return switching;
}

/** Keep the outgoing relay's key: a saved relay's profile, the built-in
 *  slot, or — a custom relay not saved yet — a new saved relay, so its key
 *  isn't lost. */
function stashOutgoingKey(now: number): void {
  const key = settings.get('teamSessionsKey');
  const url = normUrl(settings.get('pairingRelayUrl'));
  if (!url) {
    settings.set('relayBuiltinTeamKey', key);
    return;
  }
  const hit = activeProfile();
  if (hit) {
    if (hit.teamKey !== key) save(settings.get('relayProfiles').map((p) => (p.id === hit.id ? { ...p, teamKey: key } : p)));
    return;
  }
  rememberConnectedRelay({ now });
}

export interface SwitchHooks {
  /** A co-editing session is live in this window. */
  sessionLive(): boolean;
  /** "You're in a session on <label>. Switching relays leaves it." */
  confirmLeave(label: string): Promise<boolean>;
  /** Leave every live session (resumable). False = couldn't; don't switch. */
  leaveSessions(): Promise<boolean>;
}

export type SwitchResult = 'switched' | 'unchanged' | 'cancelled' | 'failed' | 'missing';

/** Is `target` (a saved relay's id, or BUILTIN_RELAY) the relay in use? */
export function isCurrent(target: string): boolean {
  if (target === BUILTIN_RELAY) return !settings.get('pairingRelayUrl').trim();
  return activeProfile()?.id === target;
}

/** Switch to a saved relay or the built-in one. */
export async function switchRelay(target: string, hooks: SwitchHooks, now = Date.now()): Promise<SwitchResult> {
  const profile = target === BUILTIN_RELAY ? null : settings.get('relayProfiles').find((p) => p.id === target);
  if (target !== BUILTIN_RELAY && !profile) return 'missing';
  if (isCurrent(target)) return 'unchanged';
  if (hooks.sessionLive()) {
    if (!(await hooks.confirmLeave(currentRelayLabel()))) return 'cancelled';
    if (!(await hooks.leaveSessions())) return 'failed';
  }
  switching = true;
  try {
    stashOutgoingKey(now);
    if (profile) {
      // One change: two sets would notify with a mixed URL/token pair.
      settings.setMany({ teamSessionsKey: profile.teamKey, pairingRelayToken: profile.token, pairingRelayUrl: profile.url });
      save(settings.get('relayProfiles').map((p) => (p.id === profile.id ? { ...p, lastUsed: now } : p)));
    } else {
      settings.setMany({ teamSessionsKey: settings.get('relayBuiltinTeamKey'), pairingRelayToken: '', pairingRelayUrl: '' });
    }
  } finally {
    switching = false;
  }
  return 'switched';
}

/** Point Settings at `url` + `token` from a team file ("Use team relay")
 *  or an invite link, as a switch rather than an edit: the outgoing relay
 *  keeps its key, and the new relay starts with the key it already had
 *  saved, or none, so the file's key (applied by the caller right after)
 *  lands on the new relay instead of being filed under the old one. A new
 *  token at the same per-team address (a rotation) keeps the current key,
 *  as relayEdited does. */
export function adoptRelay(url: string, token: string, now = Date.now()): void {
  const prev = { url: settings.get('pairingRelayUrl'), token: settings.get('pairingRelayToken') };
  if (relayMatchKey(prev.url, prev.token) === relayMatchKey(url, token)) return;
  const rotated = !!normUrl(prev.url) && sameTeam(prev, { url, token });
  const currentKey = settings.get('teamSessionsKey');
  switching = true;
  try {
    stashOutgoingKey(now);
    const into = findProfile(settings.get('relayProfiles'), url, token);
    // One change: setting the token first used to notify with {old URL,
    // new token}, and main sent the new relay's token to the old relay.
    settings.setMany({ teamSessionsKey: into?.teamKey ?? (rotated ? currentKey : ''), pairingRelayToken: token, pairingRelayUrl: url });
    if (into) save(settings.get('relayProfiles').map((p) => (p.id === into.id ? { ...p, lastUsed: now } : p)));
  } finally {
    switching = false;
  }
}

/** URL / token typed in Settings settled from `prev` to the current pair:
 *  the outgoing relay keeps its key (saved with it, so fixing a typo gets
 *  it back), and a saved relay switched to by typing its address gets its
 *  own key back. An unknown relay starts with no key: one team's key must
 *  never reach another team's relay. Only a new token at the same per-team
 *  address (a rotation) keeps it. */
export function relayEdited(prev: { url: string; token: string }, now = Date.now()): void {
  const cur = { url: settings.get('pairingRelayUrl'), token: settings.get('pairingRelayToken') };
  if (relayMatchKey(prev.url, prev.token) === relayMatchKey(cur.url, cur.token)) return;
  const key = settings.get('teamSessionsKey');
  const list = settings.get('relayProfiles');
  const out = findProfile(list, prev.url, prev.token);
  if (!normUrl(prev.url)) settings.set('relayBuiltinTeamKey', key);
  else if (out) {
    if (out.teamKey !== key) save(list.map((p) => (p.id === out.id ? { ...p, teamKey: key } : p)));
  } else if (key) {
    // A custom relay never saved (it never connected): keep its key anyway.
    save([
      ...list,
      { id: newId(), label: defaultRelayLabel(prev.url), labelCustom: false, url: normUrl(prev.url), token: prev.token, teamKey: key, lastUsed: now },
    ]);
  }
  const into = findProfile(settings.get('relayProfiles'), cur.url, cur.token);
  if (into) {
    settings.set('teamSessionsKey', into.teamKey);
    save(settings.get('relayProfiles').map((p) => (p.id === into.id ? { ...p, lastUsed: now } : p)));
  } else if (!normUrl(cur.url)) {
    settings.set('teamSessionsKey', settings.get('relayBuiltinTeamKey'));
  } else if (!(normUrl(prev.url) && sameTeam(prev, cur))) {
    settings.set('teamSessionsKey', '');
  }
}

export type TeamKeyOrigin = 'file' | 'minted' | { relay: { url: string; token: string } };

/** Record where `key` came from (newest first). */
export function noteTeamKeyOrigin(key: string, origin: TeamKeyOrigin): void {
  if (!key) return;
  const o = typeof origin === 'string' ? origin : `dir:${relayMatchKey(origin.relay.url, origin.relay.token)}`;
  const rest = settings.get('teamKeyOrigins').filter((x) => x.k !== key);
  settings.set('teamKeyOrigins', [{ k: key, o }, ...rest].slice(0, 20));
}

/** May `key` go to the current relay's team list? A key from a team file
 *  or made here, yes (the team carries it to whichever relay it uses). One
 *  taken from a relay's team list goes only back to that relay. A key with
 *  no record (an older build's) falls back to: not when it is another
 *  team's saved relay's key. */
export function keyBelongsHere(key: string): boolean {
  const cur = { url: settings.get('pairingRelayUrl'), token: settings.get('pairingRelayToken') };
  const origin = settings.get('teamKeyOrigins').find((x) => x.k === key)?.o;
  if (origin === 'file' || origin === 'minted') return true;
  if (origin?.startsWith('dir:')) return origin === `dir:${relayMatchKey(cur.url, cur.token)}`;
  if (!normUrl(cur.url)) return true;
  return !settings.get('relayProfiles').some((p) => p.teamKey === key && !sameTeam(p, cur));
}

/**
 * Is `token` saved for a relay on another host, with no saved relay for
 * this URL + token? That is the middle of an edit (the new relay's URL
 * typed, its token not yet): nothing may send that token to this host,
 * which would hand one relay's credential to another's operator.
 */
export function tokenFromAnotherHost(url: string, token: string, profiles: readonly RelayProfile[] = settings.get('relayProfiles')): boolean {
  const t = token.trim();
  const host = urlHost(url);
  if (!t || !host) return false;
  if (profiles.some((p) => p.token.trim() === t && urlHost(p.url) === host)) return false;
  return profiles.some((p) => p.token.trim() === t && urlHost(p.url) !== '' && urlHost(p.url) !== host);
}

function urlHost(url: string): string {
  const u = url.trim();
  if (!u) return '';
  try {
    return new URL(/^[a-z]+:\/\//i.test(u) ? u : `https://${u}`).host.toLowerCase();
  } catch {
    return '';
  }
}

/** The list as shown: most recently used first. */
export function profilesByUse(): RelayProfile[] {
  return [...settings.get('relayProfiles')].sort((a, b) => b.lastUsed - a.lastUsed);
}
