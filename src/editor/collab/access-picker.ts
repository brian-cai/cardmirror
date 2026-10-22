/**
 * The host's answer to a session access request: which of the sessions
 * they are hosting to share with the requester. Nothing is pre-ticked,
 * so approving is always an explicit choice per session.
 */

import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { isBackdropClick } from '../backdrop-click.js';
import { installModalKeys, captureFocusForDialog, armDialogFocus } from '../text-prompt.js';

export interface ShareableSession {
  key: string;
  title: string;
}

/** Resolves with the keys the host ticked (non-empty), or null on
 *  cancel / nothing ticked. */
export function pickSessionsToShare(who: string, sessions: ShareableSession[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const token = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-rejoin-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = `Share sessions with ${who}`;
    dialog.appendChild(header);

    const boxes: Array<{ key: string; el: HTMLInputElement }> = [];
    const list = document.createElement('div');
    list.className = 'pmd-rejoin-list';
    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-list-pick-empty';
      empty.textContent = "You aren't hosting any sessions right now.";
      list.appendChild(empty);
    }
    for (const s of sessions) {
      const label = document.createElement('label');
      label.className = 'pmd-rejoin-row';
      const box = document.createElement('input');
      box.type = 'checkbox';
      label.appendChild(box);
      const name = document.createElement('span');
      name.className = 'pmd-home-recent-name';
      name.textContent = s.title || 'Collaboration session';
      label.appendChild(name);
      list.appendChild(label);
      boxes.push({ key: s.key, el: box });
    }
    dialog.appendChild(list);

    let settled = false;
    let removeKeys = (): void => {};
    const finish = (value: string[] | null): void => {
      if (settled) return;
      settled = true;
      popOverlay(token);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve(value);
    };

    const footer = document.createElement('div');
    footer.className = 'pmd-rejoin-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'pmd-text-prompt-ok';
    share.textContent = 'Share selected';
    share.disabled = true;
    const sync = (): void => {
      share.disabled = !boxes.some((b) => b.el.checked);
    };
    for (const b of boxes) b.el.addEventListener('change', sync);
    share.addEventListener('click', () => {
      const keys = boxes.filter((b) => b.el.checked).map((b) => b.key);
      finish(keys.length ? keys : null);
    });
    footer.appendChild(cancel);
    footer.appendChild(share);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) finish(null);
    });
    removeKeys = installModalKeys(dialog, token, (e) => {
      if (e.key === 'Escape') {
        finish(null);
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', `Share sessions with ${who}`);
  });
}
