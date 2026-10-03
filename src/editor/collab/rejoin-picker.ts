/**
 * Join session's first screen: the sessions this user can get back into,
 * above the paste-a-code prompt.
 *
 * Two sources, merged by room:
 *  - SAVED sessions (collab-store session records): a copy kept on this
 *    machine, from closing with "keep", a crash, a full room or a failed
 *    resume. Rejoining resumes it, flushing any edits that never synced.
 *  - LEFT sessions (recent rooms): rooms the user left whose credentials
 *    are remembered for a week. Rejoining is a fresh join, while the room
 *    is still alive on the relay.
 * Rooms already live in this window are left out. Either kind rejoins
 * through joinSessionWithCode, which resumes when a record exists.
 */

import { relativeTime } from '../disk-conflict.js';
import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { isBackdropClick } from '../backdrop-click.js';
import { installModalKeys, captureFocusForDialog, armDialogFocus } from '../text-prompt.js';
import {
  listSessionRecords,
  listRecentRooms,
  deleteRecentRoom,
  type PersistedSessionRecord,
  type RecentRoomRecord,
} from './collab-store.js';

export interface RejoinCandidate {
  roomId: string;
  shareCode: string;
  guestPass: string | null;
  role: 'host' | 'participant';
  title: string;
  /** 'saved': a local copy to resume; 'left': a remembered room to rejoin. */
  kind: 'saved' | 'left';
  at: number;
}

export type RejoinPick =
  | { kind: 'rejoin'; shareCode: string; guestPass: string | null }
  | { kind: 'paste' };

/** Saved sessions first-class (they hold local edits), then left rooms not
 *  already covered by a saved one; newest first; live rooms dropped. */
export function buildRejoinCandidates(
  records: readonly PersistedSessionRecord[],
  recents: readonly RecentRoomRecord[],
  isLive: (roomId: string) => boolean,
): RejoinCandidate[] {
  const out: RejoinCandidate[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (isLive(r.roomId)) continue;
    seen.add(r.roomId);
    const recent = recents.find((x) => x.roomId === r.roomId);
    out.push({
      roomId: r.roomId,
      shareCode: r.shareCode,
      guestPass: r.guestPass ?? recent?.guestPass ?? null,
      role: r.role,
      title: r.docTitle || recent?.docTitle || '',
      kind: 'saved',
      at: r.updatedAt,
    });
  }
  for (const r of recents) {
    if (seen.has(r.roomId) || isLive(r.roomId)) continue;
    out.push({
      roomId: r.roomId,
      shareCode: r.shareCode,
      guestPass: r.guestPass ?? null,
      role: r.role,
      title: r.docTitle,
      kind: 'left',
      at: r.leftAt ?? r.lastActiveAt,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function loadRejoinCandidates(isLive: (roomId: string) => boolean): Promise<RejoinCandidate[]> {
  const [records, recents] = await Promise.all([listSessionRecords(), listRecentRooms()]);
  return buildRejoinCandidates(records, recents, isLive);
}

function describe(c: RejoinCandidate): string {
  const role = c.role === 'host' ? 'You hosted' : 'You joined';
  return c.kind === 'saved'
    ? `${role} · copy saved ${relativeTime(c.at)} · rejoin syncs your edits`
    : `${role} · left ${relativeTime(c.at)}`;
}

/** The picker. Resolves with a session to rejoin, 'paste' for the share-code
 *  prompt, or null on cancel. */
export function pickSessionToJoin(candidates: RejoinCandidate[]): Promise<RejoinPick | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-rejoin-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'Join a session';
    dialog.appendChild(header);

    const list = document.createElement('div');
    list.className = 'pmd-rejoin-list';
    list.setAttribute('role', 'list');
    dialog.appendChild(list);

    let settled = false;
    let removeKeys = (): void => {};
    const finish = (value: RejoinPick | null): void => {
      if (settled) return;
      settled = true;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve(value);
    };

    const renderRows = (): void => {
      list.innerHTML = '';
      if (candidates.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pmd-rejoin-empty';
        empty.textContent = 'No recent sessions to rejoin.';
        list.appendChild(empty);
        return;
      }
      for (const c of candidates) {
        const row = document.createElement('div');
        row.className = 'pmd-rejoin-row';
        row.setAttribute('role', 'listitem');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pmd-route-btn pmd-rejoin-btn';
        const strong = document.createElement('strong');
        strong.textContent = c.title || 'Collaboration session';
        btn.appendChild(strong);
        btn.appendChild(document.createElement('br'));
        const span = document.createElement('span');
        span.textContent = describe(c);
        btn.appendChild(span);
        btn.title = c.kind === 'saved' ? 'Rejoin with your saved copy' : 'Rejoin this session';
        btn.addEventListener('click', () =>
          finish({ kind: 'rejoin', shareCode: c.shareCode, guestPass: c.guestPass }),
        );
        row.appendChild(btn);

        // Forgetting a LEFT room only drops its remembered credentials.
        // Saved copies are managed from the home screen's Sessions list,
        // whose ✕ also offers a host End.
        if (c.kind === 'left') {
          const forget = document.createElement('button');
          forget.type = 'button';
          forget.className = 'pmd-rejoin-forget';
          forget.textContent = '✕';
          forget.title = 'Forget this session';
          forget.setAttribute('aria-label', `Forget ${c.title || 'this session'}`);
          forget.addEventListener('click', () => {
            void deleteRecentRoom(c.roomId);
            candidates = candidates.filter((x) => x.roomId !== c.roomId);
            renderRows();
          });
          row.appendChild(forget);
        }
        list.appendChild(row);
      }
    };
    renderRows();

    const footer = document.createElement('div');
    footer.className = 'pmd-rejoin-footer';
    const paste = document.createElement('button');
    paste.type = 'button';
    paste.className = 'pmd-route-btn pmd-rejoin-paste';
    paste.textContent = 'Paste a share code or invite link…';
    paste.addEventListener('click', () => finish({ kind: 'paste' }));
    footer.appendChild(paste);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    footer.appendChild(cancel);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) finish(null);
    });
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        finish(null);
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', 'Join a session');
  });
}
