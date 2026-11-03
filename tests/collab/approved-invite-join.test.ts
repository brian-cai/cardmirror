import { describe, expect, it } from 'vitest';
import { APPROVAL_JOIN_WINDOW_MS, invitesForAskedRooms } from '../../src/editor/collab/approved-invite-join.js';
import { looksLikeSessionCode } from '../../src/editor/collab/rejoin-picker.js';

describe('invites answering a join request', () => {
  const at = 1_000_000;
  const asked = new Map([['room-a', at]]);
  const item = (room: string | null, receivedAt: number) => ({ room, receivedAt });
  const roomOf = (it: { room: string | null }) => it.room;

  it('picks the invite for the room asked about, after asking', () => {
    const items = [item('room-a', at + 30_000), item('room-b', at + 30_000), item('room-a', at - 60_000), item(null, at + 1)];
    expect(invitesForAskedRooms(items, asked, roomOf, at + 60_000)).toEqual([items[0]]);
  });

  it('lets the request lapse after the window', () => {
    expect(invitesForAskedRooms([item('room-a', at + 1)], asked, roomOf, at + APPROVAL_JOIN_WINDOW_MS + 1)).toEqual([]);
  });
});

describe('clipboard session-code sniff', () => {
  it('accepts codes and join links only', () => {
    expect(looksLikeSessionCode(' cmshare1.room.key\n')).toBe('cmshare1.room.key');
    expect(looksLikeSessionCode('cmview1.room.key')).toBe('cmview1.room.key');
    expect(looksLikeSessionCode('https://cardmirror.app/#join=cmshare2.r.k.1.0&pass=x')).toMatch(/^https/);
    expect(looksLikeSessionCode('https://example.com/#other=1')).toBeNull();
    expect(looksLikeSessionCode('paste cmshare1.room.key')).toBeNull();
    expect(looksLikeSessionCode(42)).toBeNull();
  });
});
