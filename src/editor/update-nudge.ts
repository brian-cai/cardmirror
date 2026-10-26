/**
 * Weekly update reminder (xtgg): the status-bar chip is easy to miss, and
 * people who never quit the app never install a staged update. So once a
 * week, on Wednesday (the quietest day for tournaments), a pending update
 * gets one dialog: install now, or later. Nothing is shown when no update is
 * pending, in tournament mode, while the round timer runs (or ran in the
 * last 30 minutes), or while a co-editing session is live in any window
 * (it waits for those to end, and gives up at midnight). The dialog opens
 * with "Later" focused and ignores the keyboard for its first second, so
 * someone typing when it appears can't restart the app by accident.
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
  /** Tournament mode (tournament-mode.ts) is on. */
  paused: boolean;
  /** A co-editing session is live in any window. */
  sessionLive: boolean;
  /** The round timer is running or ran in the last 30 minutes. */
  timerBusy?: boolean;
}

export function shouldNudge(i: NudgeInputs): boolean {
  return (
    !!i.state &&
    i.now.getDay() === NUDGE_DAY &&
    i.lastDay !== localDayKey(i.now) &&
    !i.paused &&
    !i.sessionLive &&
    !i.timerBusy
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
    /** Any window's live session (may ask the main process). */
    sessionLive: () => boolean | Promise<boolean>;
    /** The round timer is busy (quiet-hours.ts timerBusy). */
    timerBusy?: () => boolean;
    confirm: (
      message: string,
      opts: { title: string; okLabel: string; cancelLabel: string; unsolicited: boolean },
    ) => Promise<boolean>;
    now?: () => Date;
  },
): () => void {
  const now = deps.now ?? (() => new Date());
  let state: UpdateChipState | null = null;
  let open = false;
  const consider = async (): Promise<void> => {
    if (open) return;
    const at = now();
    const inputs: NudgeInputs = {
      now: at,
      state,
      lastDay: readLastDay(),
      paused: deps.paused(),
      sessionLive: false,
      timerBusy: deps.timerBusy?.() ?? false,
    };
    if (!shouldNudge(inputs)) return;
    open = true; // held across the session check, so a focus burst asks once
    let shown = false;
    try {
      if (await deps.sessionLive()) return;
      // Re-read: another window may have shown it while we asked.
      if (!shouldNudge({ ...inputs, lastDay: readLastDay(), state })) return;
      const s = state!;
      writeLastDay(localDayKey(at)); // before the dialog, so other windows don't show it too
      shown = true;
      const t = nudgeText(s);
      const ok = await deps.confirm(t.message, { title: t.title, okLabel: t.okLabel, cancelLabel: 'Later', unsolicited: true });
      if (ok) await host.updateChipAction();
    } catch (err) {
      if (shown) console.warn('Update reminder failed:', err);
    } finally {
      open = false;
    }
  };
  const run = (): void => void consider();
  const unsubscribe = host.onUpdateChip((s) => {
    state = s;
    run();
  });
  void host
    .getUpdateChipState()
    .then((s) => {
      state = s;
      run();
    })
    .catch(() => {});
  const timer = setInterval(run, 15 * 60 * 1000);
  window.addEventListener('focus', run);
  return () => {
    unsubscribe();
    clearInterval(timer);
    window.removeEventListener('focus', run);
  };
}
