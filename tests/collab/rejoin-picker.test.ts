// @vitest-environment jsdom
/**
 * Join session's picker: saved copies and left rooms merged by room, live
 * rooms hidden, and the dialog's rejoin / forget / paste / cancel outcomes.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import {
  buildRejoinCandidates,
  pickSessionToJoin,
  type RejoinCandidate,
} from '../../src/editor/collab/rejoin-picker.js';
import {
  saveRecentRoom,
  loadRecentRoom,
  type PersistedSessionRecord,
  type RecentRoomRecord,
} from '../../src/editor/collab/collab-store.js';

const rec = (roomId: string, updatedAt: number, over: Partial<PersistedSessionRecord> = {}) =>
  ({
    roomId,
    shareCode: `code-${roomId}`,
    role: 'participant',
    docTitle: `Saved ${roomId}`,
    updatedAt,
    guestPass: null,
    ...over,
  }) as PersistedSessionRecord;
const recent = (roomId: string, lastActiveAt: number, over: Partial<RecentRoomRecord> = {}): RecentRoomRecord => ({
  roomId,
  shareCode: `code-${roomId}`,
  role: 'participant',
  docTitle: `Left ${roomId}`,
  lastActiveAt,
  ...over,
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('buildRejoinCandidates', () => {
  it('merges by room: a saved copy wins over its recent entry, newest first', () => {
    const out = buildRejoinCandidates(
      [rec('a', 100)],
      [recent('a', 500, { guestPass: 'gp', leftAt: 500 }), recent('b', 300, { leftAt: 300 })],
      () => false,
    );
    expect(out.map((c) => [c.roomId, c.kind])).toEqual([
      ['b', 'left'],
      ['a', 'saved'],
    ]);
    // The saved row borrows the guest pass the record lacks.
    expect(out.find((c) => c.roomId === 'a')!.guestPass).toBe('gp');
  });

  it('drops rooms already live in this window', () => {
    const out = buildRejoinCandidates([rec('a', 1)], [recent('b', 2)], (id) => id === 'a' || id === 'b');
    expect(out).toEqual([]);
  });
});

describe('pickSessionToJoin', () => {
  const cand = (roomId: string, kind: 'saved' | 'left'): RejoinCandidate => ({
    roomId,
    shareCode: `code-${roomId}`,
    guestPass: kind === 'left' ? 'gp' : null,
    role: 'participant',
    title: `Doc ${roomId}`,
    kind,
    at: Date.now(),
  });
  const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.pmd-rejoin-btn')];

  it('lists each session and resolves the clicked one', async () => {
    const pending = pickSessionToJoin([cand('a', 'saved'), cand('b', 'left')]);
    expect(rows().map((b) => b.querySelector('strong')!.textContent)).toEqual(['Doc a', 'Doc b']);
    rows()[1]!.click();
    expect(await pending).toEqual({ kind: 'rejoin', shareCode: 'code-b', guestPass: 'gp' });
    expect(document.querySelector('.pmd-rejoin-dialog')).toBeNull();
  });

  it('forget (left rooms only) removes the row and the remembered room', async () => {
    await saveRecentRoom(recent('b', Date.now()));
    const pending = pickSessionToJoin([cand('a', 'saved'), cand('b', 'left')]);
    const forgets = document.querySelectorAll<HTMLButtonElement>('.pmd-rejoin-forget');
    expect(forgets.length).toBe(1); // saved copies are managed from the home screen
    forgets[0]!.click();
    expect(rows().length).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    expect(await loadRecentRoom('b')).toBeNull();
    (document.querySelector('.pmd-rejoin-paste') as HTMLButtonElement).click();
    expect(await pending).toEqual({ kind: 'paste' });
  });

  it('cancel resolves null', async () => {
    const pending = pickSessionToJoin([cand('a', 'left')]);
    (document.querySelector('.pmd-route-cancel') as HTMLButtonElement).click();
    expect(await pending).toBeNull();
  });
});
