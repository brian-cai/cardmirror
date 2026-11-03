/**
 * Asked to join → approved → in, with no second click.
 *
 * A team-session join request is answered with the ordinary session
 * invite card (team-sessions.ts approveJoinRequest). Asking already said
 * "I want in", so when the invite for a room we asked about lands in the
 * inbox, this joins it straight away through the Receive pill's own Join
 * path (collabInviteJoiner) instead of leaving it for the user to open
 * the pill and click Join.
 *
 * Purely local and additive: no wire or relay change, approvers on any
 * version send the same invite, and anything that doesn't match (another
 * room, too late, a join that doesn't land) stays an ordinary invite row.
 * The pending set lives in memory in the window that asked, so exactly
 * one window acts on the answer.
 */

import { inboxStore, type InboxItem } from '../pairing/inbox-store.js';
import { parseRoomInvite } from '../pairing/room-invite.js';
import { showToast } from '../toast.js';
import { decodeShareCode } from './collab-crypto.js';
import { collabInviteJoiner } from './collab-hooks.js';

/** How long after asking an invite still counts as the answer. Long
 *  enough for the host to notice the request and approve it. */
export const APPROVAL_JOIN_WINDOW_MS = 30 * 60 * 1000;

/** roomId → epoch ms we asked. */
const asked = new Map<string, number>();
const tried = new Set<string>();
let unsubscribe: (() => void) | null = null;
let queue: Promise<void> = Promise.resolve();

/** The inbox invites answering a request: same room, received after we
 *  asked (a little clock slack), and still inside the window. Pure. */
export function invitesForAskedRooms<T extends Pick<InboxItem, 'receivedAt'>>(
  items: readonly T[],
  askedAt: ReadonlyMap<string, number>,
  roomIdOf: (item: T) => string | null,
  now: number,
): T[] {
  return items.filter((it) => {
    const roomId = roomIdOf(it);
    if (!roomId) return false;
    const at = askedAt.get(roomId);
    return at !== undefined && now - at <= APPROVAL_JOIN_WINDOW_MS && it.receivedAt >= at - 5_000;
  });
}

function inviteRoomId(item: InboxItem): string | null {
  const invite = parseRoomInvite(item);
  return invite ? (decodeShareCode(invite.shareCode)?.roomId ?? null) : null;
}

/** Call after a join request for `roomId` was sent from this window. */
export function joinWhenApproved(roomId: string): void {
  asked.set(roomId, Date.now());
  if (!unsubscribe) {
    unsubscribe = inboxStore.subscribe((items) => {
      queue = queue.then(() => joinApproved(items)).catch(() => {});
    });
  }
}

async function joinApproved(items: InboxItem[]): Promise<void> {
  const now = Date.now();
  for (const [roomId, at] of asked) if (now - at > APPROVAL_JOIN_WINDOW_MS) asked.delete(roomId);
  if (asked.size === 0) {
    unsubscribe?.();
    unsubscribe = null;
    return;
  }
  const joiner = collabInviteJoiner();
  if (!joiner) return;
  for (const item of invitesForAskedRooms(items, asked, inviteRoomId, now)) {
    if (tried.has(item.id)) continue;
    tried.add(item.id);
    const invite = parseRoomInvite(item);
    if (!invite) continue;
    const roomId = inviteRoomId(item);
    if (roomId) asked.delete(roomId);
    showToast(invite.title ? `Approved, joining “${invite.title}”…` : 'Approved, joining the session…');
    // Same as clicking Join on the row: the row is consumed only when the
    // join lands, so a cancelled or failed join leaves it for a retry.
    if (await joiner(invite.shareCode)) await inboxStore.remove(item.id);
  }
}

export function __resetApprovedInviteJoinForTests(): void {
  asked.clear();
  tried.clear();
  unsubscribe?.();
  unsubscribe = null;
  queue = Promise.resolve();
}
