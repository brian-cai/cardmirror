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
 */

import {
  initialReachability,
  inMaintenanceWindow,
  maintenanceWindowFor,
  outageText,
  outcomeForStatus,
  record,
  statusLinkFor,
  tick,
  type ReachabilityState,
} from './relay-reachability.js';
import { setRelayOutcomeListener } from './room-client.js';
import { relayBaseUrl, relayUsable } from './collab-relay.js';
import { currentRelayInfo } from './relay-info.js';
import { openExternally } from './relay-info-ui.js';
import { anyCollabSessionActive } from './collab-hooks.js';
import { getElectronHost } from '../host/index.js';

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

const norm = (b: string): string => b.replace(/\/+$/, '');

function note(base: string, status: number): void {
  const current = norm(relayBaseUrl());
  // Only the relay in use, and only one this computer can actually use: a
  // relay never set up (or a pinned session's old relay) is not news.
  if (!current || norm(base) !== current || !relayUsable()) return;
  state = record(state, current, outcomeForStatus(status), Date.now());
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
  if (!state.alerted) dismissed = false;
  render(state.alerted && !dismissed);
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
  const text = outageText({ maintenance: inMaintenanceWindow(mw, Date.now()), inSession: anyCollabSessionActive() });
  const status = statusLinkFor(base, info?.operator?.status ?? '');
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
  getElectronHost()?.onPairingRelayOutcome?.(({ base, status }) => note(base, status));
}
