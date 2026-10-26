/**
 * The "relay isn't answering" bar: a small strip at the bottom of the
 * window while the relay in use is unreachable, with the relay's status
 * page when it has one. Clears itself on the first answer.
 *
 * Fed by every relay call's outcome (room-client.ts in this window, the
 * mailbox poll in the main process). While a failing streak is open this
 * module also asks the relay's /health every PROBE_MS, so the bar comes
 * and goes on time even when nothing else is talking to the relay. The
 * rules (what counts, when to show, flapping) are in relay-reachability.ts.
 *
 * The bar shows only when someone is waiting on the relay: a co-editing
 * session is live, or a card send just failed (barWanted). A failing
 * background mailbox poll is tracked but shows nothing by itself, and
 * tournament mode shows nothing. When the computer itself is offline
 * (navigator.onLine) the bar says so instead of blaming the relay.
 */

import {
  initialReachability,
  inMaintenanceWindow,
  maintenanceWindowFor,
  outageText,
  outcomeForStatus,
  record,
  barWanted,
  statusLinkFor,
  tick,
  type ReachabilityState,
} from './relay-reachability.js';
import { setRelayOutcomeListener } from './room-client.js';
import { relayBaseUrl, relayUsable } from './collab-relay.js';
import { currentRelayInfo } from './relay-info.js';
import { openExternally } from './relay-info-ui.js';
import { anyCollabSessionActive, setRelaySendFailureListener } from './collab-hooks.js';
import { getElectronHost } from '../host/index.js';
import { tournamentModeOn } from '../tournament-mode.js';

const TICK_MS = 5_000;
const PROBE_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;

let state: ReachabilityState = initialReachability();
let timer: ReturnType<typeof setInterval> | null = null;
let lastProbeAt = 0;
let probing = false;
let bar: HTMLDivElement | null = null;
/** The user closed the bar: hidden until this outage ends. */
let dismissed = false;
/** When a card send last failed to reach the relay (0 = not in this
 *  outage). Cleared by the relay's next answer; stale after SEND_FAIL_MS. */
let sendFailedAt = 0;
const SEND_FAIL_MS = 10 * 60_000;

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

const norm = (b: string): string => b.replace(/\/+$/, '');

function note(base: string, status: number): void {
  const current = norm(relayBaseUrl());
  // Only the relay in use, and only one this computer can actually use: a
  // relay never set up (or a pinned session's old relay) is not news.
  if (!current || norm(base) !== current || !relayUsable()) return;
  const outcome = outcomeForStatus(status);
  state = record(state, current, outcome, Date.now());
  if (outcome === 'ok') sendFailedAt = 0;
  sync();
}

/** A card send got no answer from the relay: this outage now matters to
 *  someone, so the bar may show; probe at once for fresh evidence. */
function noteSendFailed(): void {
  if (!relayUsable()) return;
  sendFailedAt = Date.now();
  void probe();
  sync();
}

async function probe(): Promise<void> {
  const base = norm(relayBaseUrl());
  if (!base || probing) return;
  probing = true;
  lastProbeAt = Date.now();
  try {
    const res = await fetch(`${base}/health`, { method: 'GET', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    void res.body?.cancel().catch(() => {});
    note(base, res.status);
  } catch {
    note(base, 0);
  } finally {
    probing = false;
  }
}

function sync(): void {
  const failing = state.since !== null;
  if (failing && timer === null) {
    timer = setInterval(() => {
      state = tick(state, Date.now());
      if (Date.now() - lastProbeAt >= PROBE_MS) void probe();
      sync();
    }, TICK_MS);
  } else if (!failing && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  if (!state.alerted && !isOffline()) dismissed = false;
  const wanted = barWanted({
    inSession: anyCollabSessionActive(),
    sendFailed: sendFailedAt > 0 && Date.now() - sendFailedAt < SEND_FAIL_MS,
    tournamentMode: tournamentModeOn(),
  });
  // Offline: say so right away (no streak needed: the OS already told us).
  render(wanted && (state.alerted || (isOffline() && relayUsable())) && !dismissed);
}

function render(show: boolean): void {
  if (typeof document === 'undefined') return;
  if (!show) {
    bar?.remove();
    bar = null;
    return;
  }
  const base = norm(relayBaseUrl());
  const info = currentRelayInfo();
  const mw = maintenanceWindowFor(base, info?.maintenance ?? null);
  const offline = isOffline();
  const text = outageText({ maintenance: inMaintenanceWindow(mw, Date.now()), inSession: anyCollabSessionActive(), offline });
  const status = offline ? '' : statusLinkFor(base, info?.operator?.status ?? '');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'pmd-relay-down';
    bar.setAttribute('role', 'status');
    document.body.appendChild(bar);
  }
  const key = `${text}|${status}`;
  if (bar.dataset['key'] === key) return;
  bar.dataset['key'] = key;
  bar.replaceChildren();
  const msg = document.createElement('span');
  msg.textContent = text;
  bar.append(msg);
  if (status) {
    const a = document.createElement('a');
    a.href = status;
    a.textContent = 'Status';
    a.className = 'pmd-relay-down-link';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openExternally(status);
    });
    bar.append(' · ', a);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pmd-relay-down-close';
  close.setAttribute('aria-label', 'Hide until the relay is back');
  close.textContent = '×';
  close.addEventListener('click', () => {
    dismissed = true;
    render(false);
  });
  bar.append(close);
}

let started = false;

/** Boot: listen to this window's relay calls and the main process's
 *  mailbox polls. Idempotent. */
export function startRelayReachability(): void {
  if (started) return;
  started = true;
  setRelayOutcomeListener(note);
  setRelaySendFailureListener(noteSendFailed);
  getElectronHost()?.onPairingRelayOutcome?.(({ base, status }) => note(base, status));
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      dismissed = false;
      void probe();
      sync();
    });
    window.addEventListener('offline', () => sync());
  }
}
