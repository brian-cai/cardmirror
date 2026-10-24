/**
 * Weekly update reminder (xtgg): the status-bar chip is easy to miss, and
 * people who never quit the app never install a staged update. So once a
 * week, on Wednesday (the quietest day for tournaments), a pending update
 * gets one dialog: install now, or later. Nothing is shown when no update is
 * pending, during the tournament pause, or while a co-editing session is
 * live (it waits for the session to end, and gives up at midnight).
 *
 * One reminder per Wednesday across every window: the day it was shown is
 * kept in localStorage. Pure decision (`shouldNudge`) plus a small wiring
 * function, so the rule is testable without the app shell.
 */

import type { UpdateChipHost, UpdateChipState } from './update-chip.js';

/** Date#getDay() value for the reminder day: Wednesday. */
export const NUDGE_DAY = 3;
const STORAGE_KEY = 'cm.updateNudge.lastDay';

/** Local calendar day, e.g. "2026-10-28". */
export function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface NudgeInputs {
  now: Date;
  state: UpdateChipState | null;
  /** localDayKey of the last reminder, or null. */
  lastDay: string | null;
  /** The tournament pause (Settings → General) is on. */
  paused: boolean;
  /** A co-editing session is live in this window. */
  sessionLive: boolean;
}

export function shouldNudge(i: NudgeInputs): boolean {
  return (
    !!i.state &&
    i.now.getDay() === NUDGE_DAY &&
    i.lastDay !== localDayKey(i.now) &&
    !i.paused &&
    !i.sessionLive
  );
}

export function nudgeText(s: UpdateChipState): { title: string; message: string; okLabel: string } {
  return s.state === 'ready'
    ? {
        title: `Update to CardMirror ${s.version}?`,
        message:
          `CardMirror ${s.version} is downloaded and ready. Wednesday is update day, since it's the quietest day for tournaments. ` +
          'Restarting installs it and takes a few seconds; save your work first.',
        okLabel: 'Restart and update',
      }
    : {
        title: `CardMirror ${s.version} is out`,
        message:
          `A new version of CardMirror (${s.version}) is available. Wednesday is update day, since it's the quietest day for tournaments. ` +
          'Open the download page to get it?',
        okLabel: 'Get the update',
      };
}

function readLastDay(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLastDay(day: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, day);
  } catch {
    /* storage blocked: at worst the reminder repeats */
  }
}

/**
 * Watch for a pending update and show the reminder when `shouldNudge` says
 * so: on every chip change, on focus, and every 15 minutes (so a Wednesday
 * that starts mid-session, or a session that ends, is noticed).
 */
export function initUpdateNudge(
  host: UpdateChipHost,
  deps: {
    paused: () => boolean;
    sessionLive: () => boolean;
    confirm: (message: string, opts: { title: string; okLabel: string; cancelLabel: string }) => Promise<boolean>;
    now?: () => Date;
  },
): () => void {
  const now = deps.now ?? (() => new Date());
  let state: UpdateChipState | null = null;
  let open = false;
  const consider = (): void => {
    if (open) return;
    const at = now();
    if (!shouldNudge({ now: at, state, lastDay: readLastDay(), paused: deps.paused(), sessionLive: deps.sessionLive() })) return;
    const s = state!;
    writeLastDay(localDayKey(at)); // before the dialog, so other windows don't show it too
    open = true;
    const t = nudgeText(s);
    void deps
      .confirm(t.message, { title: t.title, okLabel: t.okLabel, cancelLabel: 'Later' })
      .then((ok) => (ok ? host.updateChipAction() : undefined))
      .catch((err) => console.warn('Update reminder failed:', err))
      .finally(() => {
        open = false;
      });
  };
  const unsubscribe = host.onUpdateChip((s) => {
    state = s;
    consider();
  });
  void host
    .getUpdateChipState()
    .then((s) => {
      state = s;
      consider();
    })
    .catch(() => {});
  const timer = setInterval(consider, 15 * 60 * 1000);
  window.addEventListener('focus', consider);
  return () => {
    unsubscribe();
    clearInterval(timer);
    window.removeEventListener('focus', consider);
  };
}
