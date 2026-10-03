/**
 * Recent rooms: kept past Leave so Join session can offer a rejoin; merged
 * on refresh, pruned by age.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveRecentRoom,
  listRecentRooms,
  loadRecentRoom,
  deleteRecentRoom,
  RECENT_ROOM_MAX_AGE_MS,
  type RecentRoomRecord,
} from '../../src/editor/collab/collab-store.js';

const room = (id: string, over: Partial<RecentRoomRecord> = {}): RecentRoomRecord => ({
  roomId: id,
  shareCode: `cmshare2.${id}.key.1`,
  role: 'participant',
  docTitle: `Doc ${id}`,
  lastActiveAt: Date.now(),
  ...over,
});

beforeEach(async () => {
  for (const r of await listRecentRooms()) await deleteRecentRoom(r.roomId);
});

describe('recent rooms', () => {
  it('lists newest first', async () => {
    await saveRecentRoom(room('a', { lastActiveAt: 1_000 + Date.now() - 5000 }));
    await saveRecentRoom(room('b'));
    expect((await listRecentRooms()).map((r) => r.roomId)).toEqual(['b', 'a']);
  });

  it('a refresh keeps the known title and guest pass when the new ones are empty', async () => {
    await saveRecentRoom(room('a', { docTitle: 'Aff', guestPass: 'gp' }));
    await saveRecentRoom(room('a', { docTitle: '', guestPass: null, leftAt: 5 }));
    const r = (await loadRecentRoom('a'))!;
    expect(r.docTitle).toBe('Aff');
    expect(r.guestPass).toBe('gp');
    expect(r.leftAt).toBe(5);
  });

  it('rejoining clears leftAt', async () => {
    await saveRecentRoom(room('a', { leftAt: 5 }));
    await saveRecentRoom(room('a'));
    expect((await loadRecentRoom('a'))!.leftAt).toBeUndefined();
  });

  it('prunes rooms idle past the relay reap age', async () => {
    const now = Date.now();
    await saveRecentRoom(room('old', { lastActiveAt: now - RECENT_ROOM_MAX_AGE_MS - 1 }));
    await saveRecentRoom(room('new', { lastActiveAt: now }));
    expect((await listRecentRooms(now)).map((r) => r.roomId)).toEqual(['new']);
    // Give the fire-and-forget delete a turn, then it's gone from the store.
    await new Promise((r) => setTimeout(r, 10));
    expect(await loadRecentRoom('old')).toBeNull();
  });
});
