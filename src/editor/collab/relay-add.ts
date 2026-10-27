/**
 * "+ Add a relay…" (Settings → Collaboration → Saved relays): read what the
 * user gave (an invite link, or a relay address and token) and check that
 * relay, before anything is saved. The dialog is relay-add-ui.ts; saving
 * is relay-profiles.ts addSavedRelay.
 *
 * - One validation for both forms: the address + token become the same
 *   `xtgg-relay://join?…` link an invite becomes, and main's strict parser
 *   (apps/desktop/src/relay-join-link.ts: https only, no credentials, query
 *   or fragment, a printable token) decides.
 * - The check talks to THAT relay with THAT token only. Nothing of the
 *   relay in use goes to it, and a token saved for a relay on another host
 *   is never sent here (tokenFromAnotherHost, as Settings' own check).
 *
 * Light module (no DOM), so the rules are unit-testable.
 */

import { readRelayInviteText } from '../pairing/relay-invite-text.js';
import { settings, type RelayProfile } from '../settings.js';
import { defaultRelayLabel, tokenFromAnotherHost } from './relay-profiles.js';
import type { RelayInfo } from './relay-info.js';

export interface RelayCandidate {
  relayUrl: string;
  token: string;
}

/** Main's parse of an app link (ElectronHost.relayJoinParse). */
export type ParseRelayLink = (
  raw: string,
) => Promise<{ ok: true; link: RelayCandidate } | { ok: false; reason: string }>;

export type AddRelayInput = { invite: string } | { url: string; token: string };

export type AddRelayRead = { ok: true; link: RelayCandidate } | { ok: false; message: string };

export const ADD_RELAY_NOT_INVITE =
  'That isn’t a relay invite link. Paste the extinction.gg/relay/join link your coach sent, or enter the address and token instead.';
export const ADD_RELAY_BROKEN_INVITE = 'This invite link is missing its relay or token. Ask your coach to resend it.';
export const ADD_RELAY_BAD_INVITE = 'This invite link didn’t work. Ask your coach to resend it.';
export const ADD_RELAY_NOT_HTTPS = 'The relay address must start with https://.';
export const ADD_RELAY_BAD_URL = 'That relay address isn’t valid. It looks like https://relay.example.com/relay.';
export const ADD_RELAY_BAD_TOKEN = 'That token isn’t valid: it can’t contain spaces.';
export const ADD_RELAY_DESKTOP_ONLY = 'Adding a relay works in the CardMirror desktop app.';
export const ADD_RELAY_UNREACHABLE = 'Couldn’t reach that relay. Check the address and your internet connection.';
export const ADD_RELAY_REFUSED = 'That relay didn’t accept this token.';
export const ADD_RELAY_FOREIGN_TOKEN =
  'That token is saved for a relay at another address, so it isn’t sent to this one. Check the address.';

/** The app-link form of an address + token, for main's parser. */
export function relayAppLink(url: string, token: string): string {
  return `xtgg-relay://join?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`;
}

function parseFailure(reason: string, fromInvite: boolean): string {
  if (reason === 'unsupported' || reason === 'ipc') return ADD_RELAY_DESKTOP_ONLY;
  if (/not https/.test(reason)) return ADD_RELAY_NOT_HTTPS;
  if (fromInvite) return ADD_RELAY_BAD_INVITE;
  if (/^token/.test(reason)) return ADD_RELAY_BAD_TOKEN;
  return ADD_RELAY_BAD_URL;
}

/** The relay + token the user gave, validated by main's invite parser. */
export async function readAddRelayInput(input: AddRelayInput, parse: ParseRelayLink | null): Promise<AddRelayRead> {
  let link: string;
  const fromInvite = 'invite' in input;
  if ('invite' in input) {
    const read = readRelayInviteText(input.invite);
    if (!input.invite.trim()) return { ok: false, message: 'Paste the invite link.' };
    if (read.kind === 'none') return { ok: false, message: ADD_RELAY_NOT_INVITE };
    if (read.kind === 'broken') return { ok: false, message: ADD_RELAY_BROKEN_INVITE };
    link = read.link;
  } else {
    let url = input.url.trim();
    const token = input.token.trim();
    if (!url) return { ok: false, message: 'Enter the relay address.' };
    if (!token) return { ok: false, message: 'Enter the relay token.' };
    // "relay.example.com/relay" typed without a scheme means https.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`;
    link = relayAppLink(url, token);
  }
  if (!parse) return { ok: false, message: ADD_RELAY_DESKTOP_ONLY };
  const parsed = await parse(link).catch(() => ({ ok: false as const, reason: 'ipc' }));
  if (!parsed.ok) return { ok: false, message: parseFailure(parsed.reason, fromInvite) };
  return { ok: true, link: parsed.link };
}

export interface RelayCheckDeps {
  /** Main's acceptance check (ElectronHost.pairingRelayCheck): an
   *  authenticated, read-only mailbox GET with the given URL + token. */
  relayCheck: ((p: { relayUrl: string; relayToken: string }) => Promise<{ custom: boolean; ok: boolean; status: number }>) | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  profiles?: readonly RelayProfile[];
}

export type RelayCheckResult =
  | {
      ok: true;
      /** The team's name from its list, else the relay's own name, else its address. */
      name: string;
      /** People on the relay's team list; null when it has none to show. */
      teammates: number | null;
      info: RelayInfo | null;
    }
  | { ok: false; message: string };

/** Does `link`'s relay accept `link`'s token, and what is it called? */
export async function checkNewRelay(link: RelayCandidate, deps: RelayCheckDeps): Promise<RelayCheckResult> {
  if (!deps.relayCheck) return { ok: false, message: ADD_RELAY_DESKTOP_ONLY };
  if (tokenFromAnotherHost(link.relayUrl, link.token, deps.profiles ?? settings.get('relayProfiles'))) {
    return { ok: false, message: ADD_RELAY_FOREIGN_TOKEN };
  }
  const [{ RoomsClient, roomsErrorDetail }, { parseRelayInfo }, { parseTeamDirectory }, { appVersion }, { relayExtHeaders }] =
    await Promise.all([
      import('./room-client.js'),
      import('./relay-info.js'),
      import('./team-directory.js'),
      import('../install-info.js'),
      import('../relay-protocol.js'),
    ]);
  const client = new RoomsClient({
    baseUrl: () => link.relayUrl,
    token: () => link.token,
    routingCode: () => '',
    // The build's id only: no install name before the user saves it.
    extHeaders: () => relayExtHeaders({ version: appVersion, installName: '' }),
    requestTimeoutMs: deps.timeoutMs ?? 8000,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  const [check, info, dir] = await Promise.allSettled([
    deps.relayCheck({ relayUrl: link.relayUrl, relayToken: link.token }),
    client.relayInfo(),
    client.getTeamDirectory(),
  ]);
  const status = check.status === 'fulfilled' ? check.value.status : 0;
  if (check.status !== 'fulfilled' || !check.value.ok) {
    if (status === 0) return { ok: false, message: ADD_RELAY_UNREACHABLE };
    // The relay's own words when it gave any (an expired plan, an install
    // limit), from the calls made with the same token.
    const said =
      (dir.status === 'rejected' ? roomsErrorDetail(dir.reason) : '') ||
      (info.status === 'rejected' ? roomsErrorDetail(info.reason) : '');
    if (said) return { ok: false, message: `The relay said: ${said}` };
    if (status === 401 || status === 403) return { ok: false, message: ADD_RELAY_REFUSED };
    if (status === 404) return { ok: false, message: 'No relay answered at that address. Check the address.' };
    return { ok: false, message: `That relay answered with an error (${status}). Try again in a moment.` };
  }
  const parsedInfo = info.status === 'fulfilled' ? parseRelayInfo(info.value) : null;
  const parsedDir = dir.status === 'fulfilled' && dir.value ? parseTeamDirectory(dir.value) : null;
  return {
    ok: true,
    name: parsedDir?.name.trim() || defaultRelayLabel(link.relayUrl, parsedInfo),
    teammates: parsedDir ? parsedDir.people.length : null,
    info: parsedInfo,
  };
}

/** "✓ Collegiate — 3 teammates" */
export function checkSummary(r: Extract<RelayCheckResult, { ok: true }>): string {
  if (r.teammates === null) return `✓ ${r.name}`;
  if (r.teammates === 0) return `✓ ${r.name} — no teammates listed yet`;
  return `✓ ${r.name} — ${r.teammates} teammate${r.teammates === 1 ? '' : 's'}`;
}
