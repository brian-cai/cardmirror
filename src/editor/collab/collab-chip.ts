/**
 * The status-bar session chip and its presence dots. Split out of collab-ui.ts.
 */

import { toggleSessionPeople } from './session-people.js';
import { reportWindowShared } from './window-shared-report.js';
import { chipSession } from './collab-ui-state.js';

export function chipEl(): HTMLElement | null {
  return document.getElementById('collab-chip');
}

export function updateChip(status: { connected: boolean; queuedUpdates: number } | null): void {
  const chip = chipEl();
  if (!chip) return;
  // Blue window frame while this window's doc is in a session.
  document.body.classList.toggle('pmd-collab-active', !!status);
  reportWindowShared();
  if (!status) {
    chip.hidden = true;
    chip.replaceChildren();
    return;
  }
  chip.hidden = false;
  if (!chip.dataset['peopleWired']) {
    // Click (or Enter / Space) → who's in this session.
    chip.dataset['peopleWired'] = '1';
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.title = 'Show who\u2019s in this session';
    chip.classList.add('pmd-status-button');
    const openPeople = (): void =>
      toggleSessionPeople(
        chip,
        () => chipSession()?.cursors.presence() ?? [],
        () => {
          const sess = chipSession();
          if (!sess) return null;
          return {
            connected: sess.lastStatus?.connected ?? true,
            queued: sess.lastStatus?.queuedUpdates ?? 0,
            offlineSince: sess.offlineSince,
            reconnect: () => sess.session.restart(),
          };
        },
      );
    chip.addEventListener('click', openPeople);
    chip.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPeople();
      }
    });
  }
  const text = status.connected
    ? status.queuedUpdates > 0
      ? `Session: sending ${status.queuedUpdates}…`
      : 'Session: synced'
    : status.queuedUpdates > 0
      ? `Session: offline — ${status.queuedUpdates} queued`
      : 'Session: offline';
  // Chip = a text label + a presence-dots strip (kept as stable children so
  // the dots can refresh on their own timer without rebuilding the label).
  let label = chip.querySelector('.pmd-collab-chip-label');
  let dots = chip.querySelector('.pmd-collab-chip-dots');
  if (!(label instanceof HTMLElement) || !(dots instanceof HTMLElement)) {
    chip.replaceChildren();
    label = document.createElement('span');
    label.className = 'pmd-collab-chip-label';
    chip.appendChild(label);
    dots = document.createElement('span');
    dots.className = 'pmd-collab-chip-dots';
    chip.appendChild(dots);
  }
  label.textContent = text;
  chip.title = status.connected
    ? 'Show who\u2019s in this session'
    : 'Not connected. Your edits are saved on this computer and send when the session reconnects. Click to reconnect now.';
  renderPresenceDots(dots as HTMLElement);
}

/** One colored dot per person in the room, hover for the name. */
export function renderPresenceDots(container: HTMLElement): void {
  const peers = chipSession()?.cursors.presence() ?? [];
  // Skip the DOM rebuild when the roster is unchanged (the 3s presence
  // timer and every chip update land here).
  const sig = peers.map((p) => `${p.peer}\u0000${p.name}\u0000${p.color}\u0000${p.self ? 1 : 0}`).join('\n');
  if (container.dataset['sig'] === sig) return;
  container.dataset['sig'] = sig;
  container.replaceChildren();
  for (const p of peers) {
    const dot = document.createElement('span');
    dot.className = 'pmd-collab-presence-dot' + (p.self ? ' pmd-collab-presence-dot-self' : '');
    dot.style.background = p.color;
    dot.title = p.self ? `${p.name} (you)` : p.name;
    container.appendChild(dot);
  }
}

/** Re-render just the dots (peers join/leave/expire between chip updates). */
export function refreshPresenceDots(): void {
  const dots = chipEl()?.querySelector('.pmd-collab-chip-dots');
  if (dots instanceof HTMLElement) renderPresenceDots(dots);
}

/** Whether `ownerUid`'s session is the one the shared chip reflects. MUST
 *  match chipSession()'s selection exactly: the two used to disagree on the
 *  sole-session fallback (chipSession applied it whenever the focused doc had
 *  no session; this predicate only when focus was unresolvable), so the chip
 *  label froze — and ghosted after that session ended — while its dots kept
 *  rendering from chipSession (audit find, 2026-07-10). */
export function isChipSession(ownerUid: string): boolean {
  return chipSession()?.ownerUid === ownerUid;
}

/** Repaint the shared chip from the CURRENT chip session's last status —
 *  called (via collab-hooks) when focus moves between docs; the chip
 *  otherwise held the previous doc's label until its next status event. */
export function refreshChipForFocus(): void {
  const sess = chipSession();
  updateChip(sess ? sess.lastStatus ?? { connected: true, queuedUpdates: 0 } : null);
}
