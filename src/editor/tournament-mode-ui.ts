/**
 * Tournament mode's switches outside Settings: the status-bar chip and
 * the command palette's "Tournament Mode" command. Both turn it on after
 * one confirm that says what it silences, and off straight away.
 */

import {
  setTournamentMode,
  tournamentModeEndText,
  tournamentModeOn,
  TOURNAMENT_MODE_SILENCES,
} from './tournament-mode.js';
import { confirmDialog } from './text-prompt.js';
import { showToast } from './toast.js';
import { settings } from './settings.js';

/** Palette command + chip click. */
export async function toggleTournamentMode(): Promise<void> {
  if (tournamentModeOn()) {
    setTournamentMode(false);
    showToast('Tournament mode is off.');
    return;
  }
  const ok = await confirmDialog(`For one week this turns off: ${TOURNAMENT_MODE_SILENCES}`, {
    title: 'Turn on tournament mode?',
    okLabel: 'Turn on',
  });
  if (!ok) return;
  setTournamentMode(true);
  showToast(`Tournament mode is on until ${tournamentModeEndText()}.`);
}

/** Render the chip: a quiet "Tournament mode" when off, lit when on. */
export function renderTournamentChip(el: HTMLButtonElement, now = Date.now()): void {
  const on = tournamentModeOn(now);
  el.hidden = false;
  el.dataset['state'] = on ? 'on' : 'off';
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
  el.textContent = on ? 'Tournament mode on' : 'Tournament mode';
  el.title = on
    ? `Tournament mode is on until ${tournamentModeEndText()}. Click to turn it off.`
    : 'Turn on tournament mode: a week with no update checks, reminders, relay notices or join-request sounds.';
}

/** Wire the status-bar chip. Idempotent per element. */
export function initTournamentChip(el: HTMLButtonElement): void {
  if (el.dataset['wired']) return;
  el.dataset['wired'] = '1';
  renderTournamentChip(el);
  el.addEventListener('click', () => void toggleTournamentMode().then(() => renderTournamentChip(el)));
  let prev = settings.get('updateChecksPausedUntil');
  settings.subscribe((st) => {
    if (st.updateChecksPausedUntil === prev) return;
    prev = st.updateChecksPausedUntil;
    renderTournamentChip(el);
  });
  // The week running out flips it with no settings change.
  setInterval(() => renderTournamentChip(el), 60 * 60 * 1000);
}
