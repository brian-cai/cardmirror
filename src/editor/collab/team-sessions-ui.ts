/**
 * Team sessions: the join-request prompt — "Alex wants to join: Approve /
 * Deny" — as a status-bar segment next to the session chip. Non-modal
 * (nothing floats over the page, and the editor keeps focus); one request
 * at a time with a "+N more" count, across every session in the window.
 *
 * The watcher (team-sessions.ts watchJoinRequests) feeds each room's
 * current pending set; Approve / Deny run the caller's handlers. A request
 * acted on here stays hidden even if the next poll still lists it (the
 * DELETE may not have landed yet, or another participant's did first).
 *
 * Keyboard: the palette's Approve Join Request / Deny Join Request answer
 * the oldest request, and the card's buttons are reachable with Tab
 * (Approve, then Deny). In tournament mode the desktop notification for a
 * request arrives without a sound; the card still shows.
 */

import type { PendingJoinRequest } from './team-sessions.js';
import { tournamentModeOn } from '../tournament-mode.js';
import { showToast } from '../toast.js';

export interface JoinRequestHandlers {
  approve(req: PendingJoinRequest): Promise<void>;
  deny(req: PendingJoinRequest): Promise<void>;
  /** The session's name, for "wants to join “Aff K”" with several rooms. */
  sessionName(): string;
}

interface RoomRequests {
  requests: PendingJoinRequest[];
  handlers: JoinRequestHandlers;
}

const rooms = new Map<string, RoomRequests>();
const handled = new Set<string>();
let busy = false;

const ELEMENT_ID = 'team-join-requests';

function element(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(ELEMENT_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = ELEMENT_ID;
  // A card above the status bar's right end (BCai's build): a segment in
  // the bar itself was easy to miss. Still non-modal: nothing covers the
  // page and the editor keeps focus.
  el.className = 'pmd-team-join-requests pmd-team-join-requests-floating pmd-team-join-requests-card';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

function pending(): Array<{ req: PendingJoinRequest; room: RoomRequests }> {
  const out: Array<{ req: PendingJoinRequest; room: RoomRequests }> = [];
  for (const room of rooms.values()) {
    for (const req of room.requests) if (!handled.has(req.requestId)) out.push({ req, room });
  }
  return out.sort((a, b) => a.req.createdAt - b.req.createdAt);
}

function render(): void {
  const all = pending();
  const el = all.length > 0 ? element() : document.getElementById(ELEMENT_ID);
  if (!el) return;
  if (all.length === 0) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  const { req, room } = all[0]!;
  notifyIfAway(all.map((x) => x.req));
  el.hidden = false;
  el.replaceChildren();
  const text = document.createElement('span');
  text.className = 'pmd-team-join-requests-text';
  const where = rooms.size > 1 ? ` “${room.handlers.sessionName()}”` : '';
  text.textContent = `${req.name} wants to join${where}:`;
  el.appendChild(text);
  el.setAttribute('aria-label', `Join request from ${req.name}`);
  const act = (label: string, which: 'approve' | 'deny'): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-team-join-requests-btn' + (which === 'approve' ? ' pmd-team-join-requests-approve' : '');
    b.textContent = label;
    b.setAttribute('aria-label', `${label} ${req.name}`);
    b.dataset['answer'] = which;
    b.disabled = busy;
    b.addEventListener('click', () => answer(req, room, which));
    return b;
  };
  el.appendChild(act('Approve', 'approve'));
  el.appendChild(act('Deny', 'deny'));
  if (all.length > 1) {
    const more = document.createElement('span');
    more.className = 'pmd-team-join-requests-more';
    more.textContent = `+${all.length - 1} more`;
    el.appendChild(more);
  }
}

/** Run Approve / Deny for one request (card button or palette). */
function answer(req: PendingJoinRequest, room: RoomRequests, which: 'approve' | 'deny'): void {
  if (busy) return;
  busy = true;
  // Re-rendering replaces the buttons; keep the focus on the card if it
  // was there, so a keyboard user lands on the next request's Approve.
  const el = document.getElementById(ELEMENT_ID);
  const hadFocus = !!el && el.contains(document.activeElement);
  handled.add(req.requestId);
  render();
  const run = which === 'approve' ? room.handlers.approve(req) : room.handlers.deny(req);
  void run
    .catch(() => {})
    .finally(() => {
      busy = false;
      render();
      if (hadFocus) document.querySelector<HTMLButtonElement>(`#${ELEMENT_ID}:not([hidden]) button`)?.focus();
    });
}

/** Palette: answer the oldest pending request. */
export function answerFirstJoinRequest(which: 'approve' | 'deny'): void {
  const first = pending()[0];
  if (!first) {
    showToast('No one is asking to join right now.');
    return;
  }
  answer(first.req, first.room, which);
}

/** A desktop notification for a new request while this window isn't in
 *  front (once per request), so a host reading elsewhere still sees it. */
const notified = new Set<string>();
function notifyIfAway(reqs: PendingJoinRequest[]): void {
  if (typeof document === 'undefined' || typeof Notification === 'undefined') return;
  const away = document.hidden || !document.hasFocus();
  for (const r of reqs) {
    if (notified.has(r.requestId)) continue;
    notified.add(r.requestId);
    if (!away) continue;
    try {
      new Notification(`${r.name} wants to join your session`, {
        body: 'Open CardMirror to approve or deny.',
        // Tournament mode: no sound in the middle of a round.
        silent: tournamentModeOn(),
      });
    } catch {
      /* notifications off: the card is still there */
    }
  }
}

/** A room's current pending requests (the full set from the last poll). */
export function setJoinRequests(roomId: string, requests: PendingJoinRequest[], handlers: JoinRequestHandlers): void {
  if (requests.length === 0) rooms.delete(roomId);
  else rooms.set(roomId, { requests, handlers });
  // Forget handled ids the relay no longer lists (bounded memory).
  const live = new Set([...rooms.values()].flatMap((r) => r.requests.map((q) => q.requestId)));
  for (const id of handled) if (!live.has(id)) handled.delete(id);
  render();
}

/** Undo a local hide (an approve whose invite failed: offer it again). */
export function unhideJoinRequest(requestId: string): void {
  handled.delete(requestId);
  render();
}

export function clearJoinRequests(roomId: string): void {
  setJoinRequests(roomId, [], { approve: async () => {}, deny: async () => {}, sessionName: () => '' });
}

export function __resetJoinRequestsUiForTests(): void {
  rooms.clear();
  handled.clear();
  busy = false;
  document.getElementById(ELEMENT_ID)?.remove();
}
