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
  whoIsIn,
  type RejoinCandidate,
} from '../../src/editor/collab/rejoin-picker.js';
import { settings } from '../../src/editor/settings.js';
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
  const box = () => document.querySelector<HTMLInputElement>('.pmd-rejoin-input')!;
  const tick = () => new Promise((r) => setTimeout(r, 5));
  const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  it('lists each session and resolves the clicked one', async () => {
    const pending = pickSessionToJoin([cand('a', 'saved'), cand('b', 'left')]);
    expect(rows().map((b) => b.querySelector('.pmd-home-recent-name')!.textContent)).toEqual(['Doc a', 'Doc b']);
    // Same row anatomy as the home screen's Sessions list.
    expect(rows()[0]!.classList.contains('pmd-home-session-open')).toBe(true);
    expect(rows()[0]!.querySelector('.pmd-home-session-role')!.textContent).toBe('JOINED');
    rows()[1]!.click();
    expect(await pending).toEqual({ kind: 'rejoin', shareCode: 'code-b', guestPass: 'gp' });
    expect(document.querySelector('.pmd-rejoin-dialog')).toBeNull();
  });

  it('the paste box comes first and has focus: paste, Enter, joined', async () => {
    const pending = pickSessionToJoin([cand('a', 'saved')]);
    await tick();
    const dialog = document.querySelector('.pmd-rejoin-dialog')!;
    expect(document.activeElement, 'no click needed before pasting').toBe(box());
    // The box sits above the session list.
    const order = [...dialog.querySelectorAll('.pmd-rejoin-input, .pmd-rejoin-list')].map((e) => e.className.includes('input'));
    expect(order).toEqual([true, false]);
    box().value = '  cmshare2.room.key.1  ';
    key('Enter');
    expect(await pending).toEqual({ kind: 'code', text: 'cmshare2.room.key.1' });
  });

  it('the Join button submits the box; an empty box does not close the dialog', async () => {
    const pending = pickSessionToJoin([cand('a', 'saved')]);
    await tick();
    const join = document.querySelector<HTMLButtonElement>('.pmd-rejoin-join')!;
    join.click();
    expect(document.querySelector('.pmd-rejoin-dialog'), 'still open').not.toBeNull();
    box().value = 'https://cardmirror.app/#join=abc';
    join.click();
    expect(await pending).toEqual({ kind: 'code', text: 'https://cardmirror.app/#join=abc' });
  });

  it('with nothing to rejoin it is just the box', async () => {
    const pending = pickSessionToJoin([]);
    await tick();
    expect(document.querySelector<HTMLElement>('.pmd-rejoin-section')!.hidden).toBe(true);
    expect(document.activeElement).toBe(box());
    box().value = 'code-x';
    key('Enter');
    expect(await pending).toEqual({ kind: 'code', text: 'code-x' });
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
    key('Escape');
    expect(await pending).toBeNull();
  });

  it('cancel resolves null', async () => {
    const pending = pickSessionToJoin([cand('a', 'left')]);
    (document.querySelector('.pmd-route-cancel') as HTMLButtonElement).click();
    expect(await pending).toBeNull();
  });
});

describe('finding the right session (2026-10-22)', () => {
  const cand = (roomId: string, title: string, relay?: string): RejoinCandidate => ({
    roomId,
    shareCode: `code-${roomId}`,
    guestPass: null,
    role: 'participant',
    title,
    kind: 'left',
    at: Date.now(),
    ...(relay ? { relay } : {}),
  });
  const visible = () =>
    [...document.querySelectorAll<HTMLElement>('.pmd-rejoin-row')].filter((r) => !r.hidden).map((r) => r.querySelector('.pmd-home-recent-name')!.textContent);
  const box = () => document.querySelector<HTMLInputElement>('.pmd-rejoin-input')!;
  const type = (t: string) => {
    box().value = t;
    box().dispatchEvent(new Event('input'));
  };

  it('typing filters the sessions; a pasted code does not', async () => {
    const pending = pickSessionToJoin([cand('a', 'Aff blocks'), cand('b', 'Neg K file')]);
    type('neg');
    expect(visible()).toEqual(['Neg K file']);
    type('cmshare2.room.key.1');
    expect(visible()).toEqual(['Aff blocks', 'Neg K file']);
    document.querySelector<HTMLButtonElement>('.pmd-route-cancel')!.click();
    expect(await pending).toBeNull();
  });

  it('says which relay a session is on, and the pick carries it', async () => {
    settings.set('pairingRelayUrl', '');
    const pending = pickSessionToJoin([cand('a', 'Aff blocks', 'https://relay.example/r/college')]);
    const meta = document.querySelector('.pmd-rejoin-row .pmd-home-recent-path')!.textContent!;
    expect(meta).toContain('on relay.example/r/college (switches relay)');
    type('college');
    expect(visible()).toEqual(['Aff blocks']);
    document.querySelector<HTMLButtonElement>('.pmd-rejoin-btn')!.click();
    expect(await pending).toEqual({ kind: 'rejoin', shareCode: 'code-a', guestPass: null, relay: 'https://relay.example/r/college' });
  });

  it('who is in a team session', () => {
    expect(whoIsIn({ participants: 0, people: [] })).toBe('nobody in it now');
    expect(whoIsIn({ participants: 3 })).toBe('3 people in it');
    expect(whoIsIn({ participants: 2, people: ['Ana', 'Ben'] })).toBe('Ana and Ben');
    expect(whoIsIn({ participants: 5, people: ['Ana', 'Ben', 'Cy', 'Di'] })).toBe('Ana, Ben, Cy and 2 others');
  });
});
