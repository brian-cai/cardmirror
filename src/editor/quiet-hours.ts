/**
 * When the app must not interrupt (xtgg): the checks the reminders and the
 * update restart run before they pop up anything.
 *
 *  - The round timer: running now, or ran in the last TIMER_QUIET_MS. A
 *    speech or prep that just ended usually means another one is coming.
 *  - Co-editing sessions in ANY window: the old check counted only the
 *    window asking, so a session in another window still got a restart
 *    prompt.
 */

import { getTimerState, subscribeTimer } from './timer-state.js';
import { getElectronHost } from './host/index.js';
import { collabLiveSessionCount } from './collab/collab-hooks.js';

/** Quiet for this long after the timer stops. */
export const TIMER_QUIET_MS = 30 * 60 * 1000;
const LAST_RUN_KEY = 'cm.timer.lastRunAt';

/** Pure rule: the timer is running, or stopped less than TIMER_QUIET_MS
 *  ago. */
export function timerQuiet(running: boolean, lastRunAt: number, now: number): boolean {
  return running || (lastRunAt > 0 && now - lastRunAt < TIMER_QUIET_MS);
}

function readLastRun(): number {
  try {
    const n = Number(localStorage.getItem(LAST_RUN_KEY));
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastRun(at: number): void {
  try {
    localStorage.setItem(LAST_RUN_KEY, String(at));
  } catch {
    /* storage blocked: this window still remembers it */
  }
}

let lastRunAt = 0;
let watching = false;

/** Boot: remember when the timer last ran (kept in localStorage, so a
 *  window opened after the speech still knows). Idempotent. */
export function startTimerQuietWatch(): void {
  if (watching) return;
  watching = true;
  lastRunAt = readLastRun();
  let wasRunning = getTimerState().running;
  subscribeTimer((s) => {
    if (s.running || wasRunning) {
      lastRunAt = Date.now();
      writeLastRun(lastRunAt);
    }
    wasRunning = s.running;
  });
}

/** Is the round timer busy, or was it a moment ago? */
export function timerBusy(now = Date.now()): boolean {
  return timerQuiet(getTimerState().running, Math.max(lastRunAt, readLastRun()), now);
}

/** Live co-editing sessions across every window (desktop: main counts
 *  each window's room claims; web: this browser's tabs' room locks). Falls
 *  back to this window's count when the host can't say. */
export async function liveSessionsAllWindows(): Promise<number> {
  const local = collabLiveSessionCount();
  try {
    const electron = getElectronHost();
    if (electron) {
      const total = await electron.collabLiveSessionTotal?.();
      return typeof total === 'number' ? Math.max(total, local) : local;
    }
    if (typeof navigator !== 'undefined' && typeof navigator.locks?.query === 'function') {
      const held = (await navigator.locks.query()).held ?? [];
      const tabs = held.filter((l) => (l.name ?? '').startsWith('cardmirror-collab-room://')).length;
      return Math.max(tabs, local);
    }
  } catch {
    /* an older preload / no locks API: this window's count */
  }
  return local;
}
