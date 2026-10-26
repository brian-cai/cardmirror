/**
 * Daily display-name reminder (xtgg): a computer with no display name shows
 * up unnamed everywhere it matters (teammates' contact lists, co-editing
 * cursors, and the relay admin's list of installs), and the setting is easy
 * to never find. So once a day, while the name is empty, a dialog asks for
 * it. "Don't ask again" turns the reminder off for good on this computer.
 *
 * Nothing is shown in tournament mode, while the round timer runs (or ran
 * in the last 30 minutes), while a co-editing session is live in any
 * window, or over another dialog (it tries again on the next check). The
 * dialog keeps the caret out of its name field ("Not now" has the focus)
 * and ignores the keyboard for its first second, so typing in the editor
 * as it pops up can't land in it. One
 * reminder per day across every window: the day it was shown is kept in
 * localStorage. Pure decision (`shouldAskName`) plus a small wiring
 * function, so the rule is testable without the app shell.
 */

import { localDayKey } from './update-nudge.js';

const LAST_DAY_KEY = 'cm.nameNudge.lastDay';
const NEVER_KEY = 'cm.nameNudge.never';
const ANSWER_KEY = 'cm.nameNudge.answer';

/** How the user last answered the reminder while they still have no name:
 *  'later' (Not now), 'never' (Don't ask again), or null (never asked, or
 *  they gave a name). Sent to the team's relay so whoever manages it can
 *  tell "declined" from "never asked". */
export function nameNudgeAnswer(): 'later' | 'never' | null {
  if (read(NEVER_KEY) === '1') return 'never';
  return read(ANSWER_KEY) === 'later' ? 'later' : null;
}

export interface NameNudgeInputs {
  now: Date;
  /** The current display name (Settings → Collaboration). */
  name: string;
  /** localDayKey of the last reminder, or null. */
  lastDay: string | null;
  /** The user ticked "Don't ask again". */
  never: boolean;
  /** Tournament mode (tournament-mode.ts) is on. */
  paused: boolean;
  /** A co-editing session is live in any window. */
  sessionLive: boolean;
  /** Another dialog is open. */
  overlayOpen: boolean;
  /** The round timer is running or ran in the last 30 minutes. */
  timerBusy?: boolean;
}

export function shouldAskName(i: NameNudgeInputs): boolean {
  return (
    i.name.trim() === '' &&
    !i.never &&
    i.lastDay !== localDayKey(i.now) &&
    !i.paused &&
    !i.sessionLive &&
    !i.overlayOpen &&
    !i.timerBusy
  );
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: at worst the reminder repeats */
  }
}

/**
 * Check on startup (after a short delay, so the window settles first), on
 * focus, and every 15 minutes, and ask when `shouldAskName` says so.
 */
export function initNameNudge(deps: {
  name: () => string;
  setName: (name: string) => void;
  paused: () => boolean;
  /** Any window's live session (may ask the main process). */
  sessionLive: () => boolean | Promise<boolean>;
  overlayOpen: () => boolean;
  /** The round timer is busy (quiet-hours.ts timerBusy). */
  timerBusy?: () => boolean;
  prompt: (opts: {
    message: string;
    detail: string;
    placeholder: string;
    okLabel: string;
    cancelLabel: string;
    checkbox: { label: string; onChange: (checked: boolean) => void };
    unsolicited: boolean;
  }) => Promise<string | null>;
  /** After an answer: lets the relay hear about it. */
  onAnswered?: () => void;
  now?: () => Date;
}): () => void {
  const now = deps.now ?? (() => new Date());
  let open = false;
  const consider = async (): Promise<void> => {
    if (open) return;
    const at = now();
    const inputs: NameNudgeInputs = {
      now: at,
      name: deps.name(),
      lastDay: read(LAST_DAY_KEY),
      never: read(NEVER_KEY) === '1',
      paused: deps.paused(),
      sessionLive: false,
      overlayOpen: deps.overlayOpen(),
      timerBusy: deps.timerBusy?.() ?? false,
    };
    if (!shouldAskName(inputs)) return;
    open = true; // held across the session check, so a focus burst asks once
    try {
      if (await deps.sessionLive()) return;
      // Re-read: another window may have asked, or a dialog opened, meanwhile.
      if (!shouldAskName({ ...inputs, name: deps.name(), lastDay: read(LAST_DAY_KEY), overlayOpen: deps.overlayOpen() })) return;
      write(LAST_DAY_KEY, localDayKey(at)); // before the dialog, so other windows don't show it too
      let never = false;
      const typed = await deps.prompt({
        message: 'What should teammates call you?',
        detail:
          'Your display name goes on cards you send, on your cursor when co-editing, and on your team’s relay, ' +
          'so your coach can tell this computer apart from the others. You can change it later in Settings → Collaboration.',
        placeholder: 'e.g. Ana Lopez',
        okLabel: 'Save',
        cancelLabel: 'Not now',
        checkbox: { label: 'Don’t ask again', onChange: (c) => (never = c) },
        unsolicited: true,
      });
      if (never) write(NEVER_KEY, '1');
      const name = typed?.trim() ?? '';
      if (name) {
        write(ANSWER_KEY, '');
        if (!deps.name().trim()) deps.setName(name.slice(0, 80));
      } else {
        write(ANSWER_KEY, 'later');
        deps.onAnswered?.();
      }
    } catch (err) {
      console.warn('Name reminder failed:', err);
    } finally {
      open = false;
    }
  };
  const run = (): void => void consider();
  const first = setTimeout(run, 5000);
  const timer = setInterval(run, 15 * 60 * 1000);
  window.addEventListener('focus', run);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    window.removeEventListener('focus', run);
  };
}
