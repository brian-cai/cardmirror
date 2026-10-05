/**
 * Tell the main process whether THIS window's document is in a
 * collaboration session, so Switch Window can mark shared windows (blue,
 * like their frame) next to the speech doc (red). Called whenever the
 * session indicators repaint; only a change is sent.
 */
import { getElectronHost } from '../host/index.js';

let last: boolean | null = null;

export function reportWindowShared(): void {
  const shared =
    document.body.classList.contains('pmd-collab-active') || document.querySelector('.pmd-pane-shared') !== null;
  if (shared === last) return;
  last = shared;
  void getElectronHost()?.setWindowShared?.(shared).catch(() => {});
}
