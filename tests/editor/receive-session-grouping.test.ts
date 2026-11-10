// @vitest-environment jsdom
/**
 * Receive pill: session invites group into one row per session, and the
 * badge counts each session once (a busy round with many teams).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

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

describe('Receive pill session rows', () => {
  const S = 'pmd-pairing-inbox';
  async function mount(items: InboxItem[]): Promise<HTMLElement> {
    const { settings } = await import('../../src/editor/settings.js');
    const gate = await import('../../src/editor/collab/collab-gate.js');
    vi.spyOn(gate, 'collabEnabled').mockReturnValue(true);
    settings.set('pairingEnabled', true);
    localStorage.setItem(S, JSON.stringify([]));
    const { inboxStore } = await import('../../src/editor/pairing/inbox-store.js');
    await inboxStore.init();
    await inboxStore.clear();
    inboxStore.addIncoming(items);
    const { ReceivePillController } = await import('../../src/editor/pairing/receive-pill-ui.js');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new ReceivePillController().mount({ parent, getFocusedView: () => null });
    return parent;
  }
  const rowsText = (root: HTMLElement): string[] =>
    [...root.querySelectorAll('.pmd-receive-list > li:not(.pmd-receive-actions)')].map((li) =>
      li.classList.contains('pmd-receive-session-fold')
        ? 'FOLD'
        : li.classList.contains('pmd-receive-row-invite')
          ? `SES ${li.querySelector('.pmd-receive-row-label')!.textContent}`
          : `CARD ${li.querySelector('.pmd-receive-row-label')!.textContent}`,
    );

  afterEach(async () => {
    const { setCollabInviteJoiner } = await import('../../src/editor/collab/collab-hooks.js');
    setCollabInviteJoiner(null);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('two sessions both show; three fold all but the newest; the block sits by time', async () => {
    const two = await mount([invite('cmshare2.r1.k', 'One', 1), invite('cmshare2.r2.k', 'Two', 2)]);
    expect(rowsText(two)).toEqual(['SES “Two”', 'SES “One”']);
    document.body.innerHTML = '';
    const three = await mount([
      invite('cmshare2.r1.k', 'One', 1),
      invite('cmshare2.r2.k', 'Two', 2),
      card(3),
      invite('cmshare2.r3.k', 'Three', 4),
      card(5),
    ]);
    expect(rowsText(three)).toEqual(['CARD A card', 'SES “Three”', 'FOLD', 'CARD A card']);
    (three.querySelector('.pmd-receive-session-fold-btn') as HTMLElement).click();
    expect(rowsText(three)).toEqual(['CARD A card', 'SES “Three”', 'FOLD', 'SES “Two”', 'SES “One”', 'CARD A card']);
    (three.querySelector('.pmd-receive-session-fold-clear') as HTMLElement).click();
    await Promise.resolve();
    expect(rowsText(three)).toEqual(['CARD A card', 'SES “Three”', 'CARD A card']);
  });

  it('Watch uses up only the watch invite; Join stays', async () => {
    const { setCollabInviteJoiner } = await import('../../src/editor/collab/collab-hooks.js');
    const joined: string[] = [];
    setCollabInviteJoiner(async (code) => {
      joined.push(code);
      return true;
    });
    const root = await mount([invite('cmshare2.rA.k', 'A', 1), invite('cmview1.rA.k', 'A', 2)]);
    const btns = [...root.querySelectorAll<HTMLButtonElement>('.pmd-receive-row-invite .pmd-receive-row-join')];
    expect(btns.map((b) => b.textContent)).toEqual(['Join', 'Watch']);
    btns[1]!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(joined).toEqual(['cmview1.rA.k']);
    const left = [...root.querySelectorAll<HTMLButtonElement>('.pmd-receive-row-invite .pmd-receive-row-join')];
    expect(left.map((b) => b.textContent)).toEqual(['Join']);
  });
});
