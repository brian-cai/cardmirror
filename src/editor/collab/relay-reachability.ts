/**
 * Relay reachability — is the relay in use answering at all?
 *
 * Every relay call this app makes (room requests, the room stream, the
 * mailbox poll in the main process) reports its outcome here. A call
 * "fails" only when the relay did not answer: a network error, a timeout,
 * or a 5xx (a proxy's 502/503 while the relay restarts). Any other answer,
 * 401/403/404 included, means the relay is up and said something — a
 * refusal has its own notices, and Truf's or anyone else's relay saying
 * 401 is never an outage.
 *
 * The tracker is pure (time is passed in) so the debounce rules are
 * testable; relay-reachability-ui.ts owns the timers, the probe and the bar.
 *
 * Rules:
 *  - Down = at least FAILURES_TO_ALERT failures in a row spanning at least
 *    MIN_OUTAGE_MS, or any unbroken failing streak older than ALERT_AFTER_MS.
 *    Two parallel calls failing in the same instant are one blip, not an
 *    outage.
 *  - The first answer clears it.
 *  - Flapping: after a bar was shown and cleared, a new outage within
 *    REARM_MS must last LONG_OUTAGE_MS before the bar comes back, so a relay
 *    bouncing up and down shows one bar, not one a minute.
 */

export const FAILURES_TO_ALERT = 2;
export const MIN_OUTAGE_MS = 5_000;
export const ALERT_AFTER_MS = 20_000;
export const REARM_MS = 5 * 60_000;
export const LONG_OUTAGE_MS = 60_000;

export type Outcome = 'ok' | 'down';

/** Classify a relay call: 'down' only when the relay did not answer.
 *  `status` 0 = network error / timeout / no response. */
export function outcomeForStatus(status: number): Outcome {
  return status === 0 || status >= 500 ? 'down' : 'ok';
}

export interface ReachabilityState {
  /** Base URL the streak belongs to; a relay switch starts over. */
  base: string;
  failures: number;
  /** Epoch ms of the first failure in the current streak, or null. */
  since: number | null;
  /** Is the bar showing? */
  alerted: boolean;
  /** When the last bar was cleared (for the flap rule); 0 = never. */
  clearedAt: number;
}

export const initialReachability = (base = ''): ReachabilityState => ({
  base,
  failures: 0,
  since: null,
  alerted: false,
  clearedAt: 0,
});

/** Should the bar be showing for this streak at `now`? */
export function shouldAlert(s: ReachabilityState, now: number): boolean {
  if (s.since === null || s.failures === 0) return false;
  const age = now - s.since;
  const rearming = s.clearedAt > 0 && now - s.clearedAt < REARM_MS;
  if (rearming) return age >= LONG_OUTAGE_MS;
  return (s.failures >= FAILURES_TO_ALERT && age >= MIN_OUTAGE_MS) || age >= ALERT_AFTER_MS;
}

/** Fold one call's outcome in. A different `base` (relay switched) resets
 *  the streak first; the bar never carries over to another relay. */
export function record(s: ReachabilityState, base: string, outcome: Outcome, now: number): ReachabilityState {
  let cur = s;
  if (base !== s.base) cur = { ...initialReachability(base), clearedAt: 0 };
  if (outcome === 'ok') {
    return {
      ...cur,
      failures: 0,
      since: null,
      alerted: false,
      clearedAt: cur.alerted ? now : cur.clearedAt,
    };
  }
  const next: ReachabilityState = {
    ...cur,
    failures: cur.failures + 1,
    since: cur.since ?? now,
  };
  return { ...next, alerted: next.alerted || shouldAlert(next, now) };
}

/** Re-evaluate with no new outcome (a timer tick): a streak can cross
 *  ALERT_AFTER_MS with no further call failing. */
export function tick(s: ReachabilityState, now: number): ReachabilityState {
  return s.alerted || !shouldAlert(s, now) ? s : { ...s, alerted: true };
}

// --- wording ---------------------------------------------------------

export interface MaintenanceWindow {
  /** "HH:MM", UTC. */
  dailyUtc: string;
  minutes: number;
}

/** Hosts this build knows the operator of (the xtgg relay's box). Only
 *  for these is a window assumed when the relay doesn't publish one. */
const isXtggHost = (host: string): boolean => host === 'extinction.gg' || host.endsWith('.extinction.gg');
const XTGG_WINDOW: MaintenanceWindow = { dailyUtc: '09:00', minutes: 30 };
const XTGG_STATUS = 'https://relaystatus.extinction.gg';

const hostOf = (base: string): string => {
  try {
    return new URL(base).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** The relay's own window if its info says one, else the known xtgg box
 *  window for *.extinction.gg, else none. */
export function maintenanceWindowFor(base: string, published: MaintenanceWindow | null): MaintenanceWindow | null {
  if (published) return published;
  return isXtggHost(hostOf(base)) ? XTGG_WINDOW : null;
}

/** Is `now` inside the daily window (which may wrap past midnight UTC)? */
export function inMaintenanceWindow(w: MaintenanceWindow | null, now: number): boolean {
  if (!w) return false;
  const m = /^(\d{2}):(\d{2})$/.exec(w.dailyUtc);
  if (!m || !(w.minutes > 0)) return false;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const d = new Date(now);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const into = (minute - start + 1440) % 1440;
  return into < w.minutes;
}

/** The status page to link: the relay's own (relay info), else the xtgg
 *  status page for *.extinction.gg, else none. */
export function statusLinkFor(base: string, published: string): string {
  if (published) return published;
  return isXtggHost(hostOf(base)) ? XTGG_STATUS : '';
}

/** The bar's sentence. */
export function outageText(opts: { maintenance: boolean; inSession: boolean }): string {
  const lead = opts.maintenance
    ? 'The relay may be restarting for updates (usually under a minute).'
    : 'The relay isn’t answering. Retrying…';
  return opts.inSession ? `${lead} Your edits are kept on this computer and send when it’s back.` : lead;
}
