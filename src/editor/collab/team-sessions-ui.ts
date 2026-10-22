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
 */

import type { PendingJoinRequest } from './team-sessions.js';

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
  el.className = 'status-segment pmd-team-join-requests';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  // Right after the session chip in the status bar; a shell without one
  // (tests, odd layouts) gets a small fixed strip instead.
  const chip = document.getElementById('collab-chip');
  if (chip?.parentElement) chip.insertAdjacentElement('afterend', el);
  else {
    el.classList.add('pmd-team-join-requests-floating');
    document.body.appendChild(el);
  }
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
  el.hidden = false;
  el.replaceChildren();
  const text = document.createElement('span');
  text.className = 'pmd-team-join-requests-text';
  const where = rooms.size > 1 ? ` “${room.handlers.sessionName()}”` : '';
  text.textContent = `${req.name} wants to join${where}:`;
  el.appendChild(text);
  const act = (label: string, run: () => Promise<void>, primary: boolean): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-team-join-requests-btn' + (primary ? ' pmd-team-join-requests-approve' : '');
    b.textContent = label;
    b.disabled = busy;
    b.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      handled.add(req.requestId);
      render();
      void run()
        .catch(() => {})
        .finally(() => {
          busy = false;
          render();
        });
    });
    return b;
  };
  el.appendChild(act('Approve', () => room.handlers.approve(req), true));
  el.appendChild(act('Deny', () => room.handlers.deny(req), false));
  if (all.length > 1) {
    const more = document.createElement('span');
    more.className = 'pmd-team-join-requests-more';
    more.textContent = `+${all.length - 1} more`;
    el.appendChild(more);
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
