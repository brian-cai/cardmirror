/**
 * Which relays a contact is on. A card only reaches someone connected to
 * the relay you send through, so after switching relays (a college
 * debater back on their high school's, a coach on two teams) the Send
 * pill, Send to Recipient and invites offer the contacts on THIS relay.
 *
 * `PairingPartner.relays` lists relay tags: a custom relay's URL
 * (normalized) or BUILTIN_RELAY_TAG. Absent or empty = every relay — the
 * behaviour before this existed, and what the original CardMirror (which
 * ignores the field) always does. So old contacts, team files and
 * contacts added on the built-in relay stay visible everywhere; contacts
 * added on a custom relay, or imported from its team list, are tagged
 * with it, and a contact can carry several.
 */
import { settings } from '../settings.js';
import type { PairingGroup, PairingPartner } from '../settings.js';
import { normalizePairingCode } from './pairing-ids.js';

export const BUILTIN_RELAY_TAG = 'builtin';
export const MAX_CONTACT_RELAYS = 20;

/** A relay URL as a tag: trimmed, no trailing slash, lower-case scheme and host. */
export function relayTag(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return BUILTIN_RELAY_TAG;
  return u.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i, (m) => m.toLowerCase());
}

/** The relay cards go through right now. */
export function currentRelayTag(): string {
  return relayTag(settings.get('pairingRelayUrl'));
}

/** Is `p` reachable on relay `tag`? Untagged contacts are on every relay. */
export function onRelay(p: Pick<PairingPartner, 'relays'>, tag: string = currentRelayTag()): boolean {
  return !p.relays?.length || p.relays.includes(tag);
}

/** The contacts on the current relay (groups filter through this too:
 *  resolveStarredTarget and the pickers drop members not passed in). */
export function partnersHere(partners: readonly PairingPartner[] = settings.get('pairingPartners')): PairingPartner[] {
  const tag = currentRelayTag();
  return partners.filter((p) => onRelay(p, tag));
}

/** How many contacts are only on other relays (for the "N on other relays" hint). */
export function partnersElsewhere(partners: readonly PairingPartner[] = settings.get('pairingPartners')): number {
  const tag = currentRelayTag();
  return partners.filter((p) => p.code && !onRelay(p, tag)).length;
}

/** Groups with at least one member on the current relay. */
export function groupsHere(
  groups: readonly PairingGroup[] = settings.get('pairingGroups'),
  partners: readonly PairingPartner[] = settings.get('pairingPartners'),
): PairingGroup[] {
  const here = new Set(partnersHere(partners).map((p) => p.code));
  return groups.filter((g) => g.memberCodes.some((c) => here.has(c)));
}

/** The tags a contact added right now gets: the custom relay, or none
 *  (every relay) on the built-in one. */
export function tagsForNewContact(): string[] | undefined {
  const tag = currentRelayTag();
  return tag === BUILTIN_RELAY_TAG ? undefined : [tag];
}

/** A new contact, tagged for the current relay. */
export function newContact(code: string, name: string): PairingPartner {
  const relays = tagsForNewContact();
  return relays ? { code, name, relays } : { code, name };
}

/**
 * After a team-list import on relay `tag`: contacts that weren't there
 * before get the tag; contacts that were, and are already tied to other
 * relays, get it added; untagged ones (every relay) stay untagged.
 */
export function tagImported(
  partners: readonly PairingPartner[],
  before: readonly PairingPartner[],
  listedCodes: readonly string[],
  tag: string,
): PairingPartner[] {
  if (tag === BUILTIN_RELAY_TAG) return [...partners];
  const listed = new Set(listedCodes.map(normalizePairingCode));
  const old = new Map(before.map((p) => [normalizePairingCode(p.code), p]));
  return partners.map((p) => {
    const code = normalizePairingCode(p.code);
    if (!listed.has(code)) return p;
    const prev = old.get(code);
    if (!prev) return { ...p, relays: [tag] };
    if (!prev.relays?.length || prev.relays.includes(tag)) return p;
    return { ...p, relays: [...prev.relays, tag].slice(-MAX_CONTACT_RELAYS) };
  });
}
