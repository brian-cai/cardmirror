/**
 * Daily display-name reminder (xtgg): a computer with no display name shows
 * up unnamed everywhere it matters (teammates' contact lists, co-editing
 * cursors, and the relay admin's list of installs), and the setting is easy
 * to never find. So once a day, while the name is empty, a dialog asks for
 * it. "Don't ask again" turns the reminder off for good on this computer.
 *
 * Nothing is shown during the tournament pause, while a co-editing session
 * is live, or over another dialog (it tries again on the next check). One
 * reminder per day across every window: the day it was shown is kept in
 * localStorage. Pure decision (`shouldAskName`) plus a small wiring
 * function, so the rule is testable without the app shell.
 */

import { localDayKey } from './update-nudge.js';

const LAST_DAY_KEY = 'cm.nameNudge.lastDay';
const NEVER_KEY = 'cm.nameNudge.never';

export interface NameNudgeInputs {
  now: Date;
  /** The current display name (Settings → Collaboration). */
  name: string;
  /** localDayKey of the last reminder, or null. */
  lastDay: string | null;
  /** The user ticked "Don't ask again". */
  never: boolean;
  /** The tournament pause (Settings → General) is on. */
  paused: boolean;
  /** A co-editing session is live in this window. */
  sessionLive: boolean;
  /** Another dialog is open. */
  overlayOpen: boolean;
}

export function shouldAskName(i: NameNudgeInputs): boolean {
  return (
    i.name.trim() === '' &&
    !i.never &&
    i.lastDay !== localDayKey(i.now) &&
    !i.paused &&
    !i.sessionLive &&
    !i.overlayOpen
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
  sessionLive: () => boolean;
  overlayOpen: () => boolean;
  prompt: (opts: {
    message: string;
    detail: string;
    placeholder: string;
    okLabel: string;
    cancelLabel: string;
    checkbox: { label: string; onChange: (checked: boolean) => void };
  }) => Promise<string | null>;
  now?: () => Date;
}): () => void {
  const now = deps.now ?? (() => new Date());
  let open = false;
  const consider = (): void => {
    if (open) return;
    const at = now();
    const inputs: NameNudgeInputs = {
      now: at,
      name: deps.name(),
      lastDay: read(LAST_DAY_KEY),
      never: read(NEVER_KEY) === '1',
      paused: deps.paused(),
      sessionLive: deps.sessionLive(),
      overlayOpen: deps.overlayOpen(),
    };
    if (!shouldAskName(inputs)) return;
    write(LAST_DAY_KEY, localDayKey(at)); // before the dialog, so other windows don't show it too
    open = true;
    let never = false;
    void deps
      .prompt({
        message: 'What should teammates call you?',
        detail:
          'Your display name goes on cards you send, on your cursor when co-editing, and on your team’s relay, ' +
          'so your coach can tell this computer apart from the others. You can change it later in Settings → Collaboration.',
        placeholder: 'e.g. Ana Lopez',
        okLabel: 'Save',
        cancelLabel: 'Not now',
        checkbox: { label: 'Don’t ask again', onChange: (c) => (never = c) },
      })
      .then((typed) => {
        if (never) write(NEVER_KEY, '1');
        const name = typed?.trim() ?? '';
        if (name && !deps.name().trim()) deps.setName(name.slice(0, 80));
      })
      .catch((err) => console.warn('Name reminder failed:', err))
      .finally(() => {
        open = false;
      });
  };
  const first = setTimeout(consider, 5000);
  const timer = setInterval(consider, 15 * 60 * 1000);
  window.addEventListener('focus', consider);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    window.removeEventListener('focus', consider);
  };
}
