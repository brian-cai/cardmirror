/**
 * Tournament mode (xtgg): one switch that keeps CardMirror quiet for a
 * week of rounds. It began as "Pause update checks for 1 week" in
 * Settings → General → About this install, and the stored setting is still
 * that one (`updateChecksPausedUntil`, epoch ms; 0 = off), so an install
 * that paused before keeps its pause and an older build reading the same
 * settings still sees updates paused.
 *
 * While it's on:
 *  - no automatic update checks or downloads (a manual check still works),
 *  - no Wednesday update reminder, and the update pill stops pulsing,
 *  - no daily name reminder,
 *  - no "relay isn't answering" bar and no relay notices,
 *  - no "Added N teammates" toasts,
 *  - join requests make no sound (the Approve / Deny card still shows).
 *
 * Light module (settings only): the relay, team-list and session modules
 * import it to stand down.
 */

import { settings } from './settings.js';

/** How long one switch-on lasts. */
export const TOURNAMENT_MODE_MS = 7 * 24 * 60 * 60 * 1000;

/** What it silences, for Settings and the palette's confirmation. */
export const TOURNAMENT_MODE_SILENCES =
  'Automatic update checks and downloads, the Wednesday update reminder and the pulsing update pill, ' +
  'the name reminder, the “relay isn’t answering” bar, relay notices, “Added teammates” messages, ' +
  'and the sound of join requests (the Approve / Deny card still shows). ' +
  'Manual update checks, card sending and co-editing work as usual.';

/** Epoch ms when it ends; 0 or past = off. */
export function tournamentModeUntil(): number {
  return settings.get('updateChecksPausedUntil');
}

export function tournamentModeOn(now = Date.now()): boolean {
  return tournamentModeUntil() > now;
}

/** On for a week from `now`, or off. */
export function setTournamentMode(on: boolean, now = Date.now()): void {
  settings.set('updateChecksPausedUntil', on ? now + TOURNAMENT_MODE_MS : 0);
}

/** "Saturday, October 31" — the day it ends. */
export function tournamentModeEndText(until = tournamentModeUntil()): string {
  return new Date(until).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

let attrTimer: ReturnType<typeof setTimeout> | null = null;

/** Mirror the state onto `<html data-tournament-mode>` (CSS: the update
 *  pill stops pulsing), and clear it when the week runs out. */
export function syncTournamentModeAttr(now = Date.now()): void {
  if (typeof document === 'undefined') return;
  const on = tournamentModeOn(now);
  document.documentElement.toggleAttribute('data-tournament-mode', on);
  if (attrTimer) clearTimeout(attrTimer);
  attrTimer = null;
  if (on) {
    const wait = Math.min(tournamentModeUntil() - now + 50, 2 ** 31 - 1);
    attrTimer = setTimeout(() => syncTournamentModeAttr(), wait);
  }
}

let watching = false;

/** Boot: keep the attribute in step with the setting (other windows'
 *  changes arrive through the settings store too). Idempotent. */
export function startTournamentModeWatch(onChange?: (on: boolean) => void): void {
  syncTournamentModeAttr();
  if (watching) return;
  watching = true;
  let prev = tournamentModeOn();
  settings.subscribe(() => {
    const on = tournamentModeOn();
    syncTournamentModeAttr();
    if (on !== prev) {
      prev = on;
      onChange?.(on);
    }
  });
}
