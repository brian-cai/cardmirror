/**
 * Relay info — the client side of the optional relay extension
 * "relay info v1" (reference-docs/relay-info-v1.md).
 *
 * On a relay the user configured, the relay can say who runs it, how this
 * credential's access stands (plan, expiry, installs), one short notice,
 * and which client builds it recommends. In the other direction every
 * request names this build (`X-Relay-Client`) and, if the user agrees,
 * this install (`X-Relay-Install-Name`, their display name).
 *
 * Strictly additive and quiet:
 *  - Only on a custom relay (Settings → Collaboration → Custom relay URL).
 *    The built-in relay and its account/entitlement path never see the
 *    new headers or the info call.
 *  - Nothing about any operator is built in: names, links and addresses
 *    all come from the info document. The only built-in identity is this
 *    build's client id and version (relay-protocol.ts RELAY_CLIENT_ID).
 *  - 404 or any other error = unsupported: nothing new is shown.
 *  - Fetched on start, when Settings → Collaboration opens, and at most
 *    hourly otherwise. Never downloads or installs anything.
 *
 * Light module (no Loro, no DOM): the settings tab and the boot wiring
 * import it. The visible parts live in relay-info-ui.ts.
 */

import { RoomsError, type RoomsClient } from './room-client.js';
import { appVersion } from '../install-info.js';
import { compareAppVersions, RELAY_CLIENT_ID, relayExtHeaders } from '../relay-protocol.js';
import { settings, type Settings } from '../settings.js';

/** Background refresh cadence (spec: at most once an hour). */
export const RELAY_INFO_REFRESH_MS = 60 * 60_000;
/** A forced refresh (settings opened) closer than this to the last fetch
 *  reuses it: opening the tab twice in a row is one request. */
const FORCE_FLOOR_MS = 5_000;

export interface RelayOperator {
  name: string;
  /** https only; '' = absent. */
  url: string;
  /** An email address; '' = absent. */
  support: string;
  status: string;
  manage: string;
}

export interface RelayInstalls {
  used: number | null;
  /** null = unlimited (absent or -1). */
  max: number | null;
  idleDays: number | null;
}

export interface RelayAccess {
  label: string;
  /** '' = absent or unknown. */
  status: 'active' | 'suspended' | '';
  /** Epoch ms; null = no expiry. */
  expiresAt: number | null;
  installs: RelayInstalls | null;
}

export interface RelayNotice {
  id: string;
  text: string;
  /** Epoch ms; null = no end. */
  until: number | null;
}

export interface RelayClientBuild {
  id: string;
  name: string;
  latest: string;
  url: string;
  note: string;
}

/** A daily window (UTC) when the relay may restart for updates. */
export interface RelayMaintenance {
  /** "HH:MM", UTC. */
  dailyUtc: string;
  minutes: number;
}

export interface RelayInfo {
  v: 1;
  operator: RelayOperator | null;
  access: RelayAccess | null;
  notice: RelayNotice | null;
  clients: RelayClientBuild[];
  /** Absent from most relays' documents (null). */
  maintenance?: RelayMaintenance | null;
}

// --- request headers --------------------------------------------------

/** The install name to send: the display name when the user leaves
 *  "Show my name…" on, else ''. Never a device or account name. */
export function installNameToSend(st: Pick<Settings, 'relayShowInstallName' | 'pairingDisplayName'>): string {
  return st.relayShowInstallName ? st.pairingDisplayName.trim() : '';
}

type HeaderSettings = Pick<Settings, 'pairingRelayUrl' | 'relayShowInstallName' | 'pairingDisplayName'>;

function liveSettings(): HeaderSettings {
  return {
    pairingRelayUrl: settings.get('pairingRelayUrl'),
    relayShowInstallName: settings.get('relayShowInstallName'),
    pairingDisplayName: settings.get('pairingDisplayName'),
  };
}

/** Is a relay the user configured in use (rather than the built-in one)? */
export function isCustomRelay(st: Pick<Settings, 'pairingRelayUrl'> = liveSettings()): boolean {
  return st.pairingRelayUrl.trim() !== '';
}

/** The relay-info headers for the next request: {} unless a custom relay
 *  is configured. Read per request, so a settings change applies to live
 *  sessions on their next call. */
export function customRelayExtHeaders(st: HeaderSettings = liveSettings()): Record<string, string> {
  if (!isCustomRelay(st)) return {};
  return relayExtHeaders({ version: appVersion, installName: installNameToSend(st) });
}

// --- the info document ------------------------------------------------

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** An https link, or '' (the spec allows only https; anything else is
 *  dropped rather than opened). */
export function httpsUrl(v: unknown): string {
  const s = str(v, 2000);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function email(v: unknown): string {
  const s = str(v, 254);
  return /^[^\s@<>"'(),;:\\]+@[^\s@<>"'(),;:\\]+\.[^\s@<>"'(),;:\\]+$/.test(s) ? s : '';
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && n >= 0 ? Math.floor(n) : null;
};

/** Parse a relay's info document. Only `v: 1` is required; every other
 *  field is optional and anything malformed or unknown is ignored. Null =
 *  not a v1 document (treated like a 404). */
export function parseRelayInfo(raw: unknown): RelayInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;

  let operator: RelayOperator | null = null;
  if (r['operator'] && typeof r['operator'] === 'object') {
    const o = r['operator'] as Record<string, unknown>;
    const op: RelayOperator = {
      name: str(o['name'], 100),
      url: httpsUrl(o['url']),
      support: email(o['support']),
      status: httpsUrl(o['status']),
      manage: httpsUrl(o['manage']),
    };
    if (op.name || op.url || op.support || op.status || op.manage) operator = op;
  }

  let access: RelayAccess | null = null;
  if (r['access'] && typeof r['access'] === 'object') {
    const a = r['access'] as Record<string, unknown>;
    let installs: RelayInstalls | null = null;
    if (a['installs'] && typeof a['installs'] === 'object') {
      const i = a['installs'] as Record<string, unknown>;
      const max = finite(i['max']);
      installs = {
        used: count(i['used']),
        max: max === null || max < 0 ? null : Math.floor(max),
        idleDays: count(i['idleDays']) || null,
      };
    }
    const status = a['status'] === 'active' || a['status'] === 'suspended' ? a['status'] : '';
    const exp = finite(a['expiresAt']);
    access = { label: str(a['label'], 100), status, expiresAt: exp !== null && exp > 0 ? exp : null, installs };
  }

  let notice: RelayNotice | null = null;
  if (r['notice'] && typeof r['notice'] === 'object') {
    const n = r['notice'] as Record<string, unknown>;
    const id = str(n['id'], 200);
    const text = str(n['text'], 280);
    const until = finite(n['until']);
    if (id && text) notice = { id, text, until: until !== null && until > 0 ? until : null };
  }

  const clients: RelayClientBuild[] = [];
  if (Array.isArray(r['clients'])) {
    for (const c of r['clients'].slice(0, 5)) {
      if (!c || typeof c !== 'object') continue;
      const e = c as Record<string, unknown>;
      const id = str(e['id'], 64);
      if (!id) continue;
      clients.push({
        id,
        name: str(e['name'], 100),
        latest: str(e['latest'], 40),
        url: httpsUrl(e['url']),
        note: str(e['note'], 200),
      });
    }
  }

  let maintenance: RelayMaintenance | null = null;
  if (r['maintenance'] && typeof r['maintenance'] === 'object') {
    const m = r['maintenance'] as Record<string, unknown>;
    const at = str(m['dailyUtc'], 5);
    const minutes = count(m['minutes']);
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(at) && minutes && minutes <= 240) maintenance = { dailyUtc: at, minutes };
  }

  return maintenance ? { v: 1, operator, access, notice, clients, maintenance } : { v: 1, operator, access, notice, clients };
}

/** The notice to show now: present, not past `until`, not dismissed. */
export function activeNotice(info: RelayInfo | null, dismissed: readonly string[], now = Date.now()): RelayNotice | null {
  const n = info?.notice;
  if (!n) return null;
  if (n.until !== null && now >= n.until) return null;
  if (dismissed.includes(n.id)) return null;
  return n;
}

/** "Update available": this build's own entry lists a newer `latest`
 *  with a link. Other entries are informational only. A version that
 *  doesn't parse never counts as newer (compareAppVersions ranks it
 *  lowest). */
export function updateHint(
  info: RelayInfo | null,
  version: string = appVersion,
  clientId: string = RELAY_CLIENT_ID,
): { latest: string; url: string } | null {
  const own = info?.clients.find((c) => c.id === clientId);
  if (!own || !own.latest || !own.url) return null;
  return compareAppVersions(own.latest, version) > 0 ? { latest: own.latest, url: own.url } : null;
}

/** "Installs: 3 of 4 in use; unused for 30 days stop counting". '' when
 *  the relay sent nothing to say. */
export function installsLine(i: RelayInstalls | null): string {
  if (!i) return '';
  const parts: string[] = [];
  if (i.used !== null) parts.push(i.max !== null ? `${i.used} of ${i.max} in use` : `${i.used} in use`);
  else if (i.max !== null) parts.push(`up to ${i.max}`);
  if (i.idleDays) parts.push(`unused for ${i.idleDays} day${i.idleDays === 1 ? '' : 's'} stop counting`);
  return parts.length ? `Installs: ${parts.join('; ')}` : '';
}

// --- fetch + cache ----------------------------------------------------

/** What a refresh needs: the relay client and the base URL it talks to
 *  (the cache key; a relay change starts over). Null = no custom relay. */
export interface RelayInfoContext {
  client: RoomsClient;
  baseUrl: string;
}

/** Fetch and parse the info document. 404, any other refusal, a non-v1
 *  body or a network failure all come back as null. */
export async function fetchRelayInfo(client: RoomsClient): Promise<{ info: RelayInfo | null; network: boolean }> {
  try {
    return { info: parseRelayInfo(await client.relayInfo()), network: false };
  } catch (err) {
    return { info: null, network: err instanceof RoomsError && err.status === 0 };
  }
}

let state: { base: string; info: RelayInfo | null; fetchedAt: number } | null = null;
let inflight: { base: string; p: Promise<RelayInfo | null> } | null = null;
const listeners = new Set<(info: RelayInfo | null) => void>();

/** The last info document for the relay in use (null = none / unsupported). */
export function currentRelayInfo(): RelayInfo | null {
  return state?.info ?? null;
}

/** Called with the new info whenever it changes (null included). */
export function onRelayInfoChanged(fn: (info: RelayInfo | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(base: string, info: RelayInfo | null, now: number): void {
  const before = state?.info ?? null;
  state = { base, info, fetchedAt: now };
  if (JSON.stringify(before) !== JSON.stringify(info)) for (const fn of listeners) fn(info);
}

/** Refresh the info for `ctx`. Without `force`, reuses a fetch from the
 *  last hour; with it (settings opened), refetches unless one ran in the
 *  last few seconds. A null ctx (no custom relay) clears everything. A
 *  network failure keeps what was shown; any other failure clears it. */
export async function refreshRelayInfo(
  ctx: RelayInfoContext | null,
  opts: { force?: boolean; now?: number } = {},
): Promise<RelayInfo | null> {
  const now = opts.now ?? Date.now();
  if (!ctx) {
    if (state) publish('', null, now);
    state = null;
    return null;
  }
  const base = ctx.baseUrl.replace(/\/+$/, '');
  if (state && state.base === base) {
    const age = now - state.fetchedAt;
    if (age < (opts.force ? FORCE_FLOOR_MS : RELAY_INFO_REFRESH_MS)) return state.info;
  }
  if (inflight && inflight.base === base) return inflight.p;
  const p = fetchRelayInfo(ctx.client).then(({ info, network }) => {
    const keep = network && state?.base === base ? state.info : info;
    publish(base, keep, opts.now ?? Date.now());
    return keep;
  });
  inflight = { base, p };
  try {
    return await p;
  } finally {
    if (inflight?.p === p) inflight = null;
  }
}

/** Test hook: reset module state between cases. */
export function __resetRelayInfoForTests(): void {
  state = null;
  inflight = null;
  listeners.clear();
}
