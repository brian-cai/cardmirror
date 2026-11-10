// @vitest-environment jsdom
/**
 * Receive pill: session invites group into one row per session, and the
 * badge counts each session once (a busy round with many teams).
 */
import { describe, it, expect } from 'vitest';

import {
  groupSessionInvites,
  inboxDisplayCount,
  inboxDisplayUnread,
} from '../../src/editor/pairing/receive-pill-ui.js';
import type { InboxItem } from '../../src/editor/pairing/inbox-store.js';

let n = 0;
const invite = (code: string, title: string, at: number, read = false, sender = 'Ana'): InboxItem => ({
  id: `i${++n}`,
  label: title,
  type: 'room-invite',
  sliceJson: { shareCode: code, title },
  senderName: sender,
  senderCode: '',
  receivedAt: at,
  read,
});
const card = (at: number, read = false): InboxItem => ({
  id: `c${++n}`,
  label: 'A card',
  type: 'card',
  sliceJson: {},
  senderName: 'Bo',
  senderCode: '',
  receivedAt: at,
  read,
});

describe('groupSessionInvites', () => {
  it('one row per room, newest first; edit and watch invites to a room share it', () => {
    const items = [
      invite('cmshare2.roomA.k', 'Aff 1AC', 1),
      invite('cmshare2.roomB.k', 'Neg', 2),
      invite('cmview1.roomA.k', 'Aff 1AC', 3, false, 'Cy'),
      invite('cmshare2.roomA.k', 'Aff 1AC', 4),
      card(5),
    ];
    const rooms = groupSessionInvites(items);
    expect(rooms.map((r) => r.roomId)).toEqual(['roomA', 'roomB']);
    expect(rooms[0]!.edit).toBe('cmshare2.roomA.k');
    expect(rooms[0]!.view).toBe('cmview1.roomA.k');
    expect(rooms[0]!.items).toHaveLength(3);
    expect(rooms[1]!.view).toBeNull();
  });

  it('badge counts each session once and each card once', () => {
    const items = [
      invite('cmshare2.roomA.k', 'A', 1, true),
      invite('cmshare2.roomA.k', 'A', 2, false),
      invite('cmshare2.roomB.k', 'B', 3, true),
      card(4, false),
      card(5, true),
    ];
    expect(inboxDisplayCount(items)).toBe(4);
    expect(inboxDisplayUnread(items)).toBe(2);
  });
});
