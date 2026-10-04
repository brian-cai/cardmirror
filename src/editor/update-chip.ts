/**
 * Status-bar update chip — install-on-confirm (adopted 2026-07-16,
 * modeled on ebb's update UX): auto-updates never dialog. The desktop
 * main process stages downloads silently and reports chip state; this
 * module renders the chip and forwards clicks. Two states:
 *
 *   'ready'     — the update is downloaded and staged (Windows/Linux).
 *                 Click = restart now and install. Users who never
 *                 click still get it on next quit (install-on-quit
 *                 stays on as the fallback).
 *   'available' — detected but not stageable (macOS until the swap
 *                 updater lands). Click = open the release page.
 *
 * Pure DOM + host-interface module so the chip logic is testable
 * outside the index.ts app shell.
 */

export interface UpdateChipState {
  state: 'available' | 'ready';
  version: string;
}

export interface UpdateChipHost {
  getUpdateChipState(): Promise<UpdateChipState | null>;
  updateChipAction(): Promise<void>;
  onUpdateChip(handler: (payload: UpdateChipState | null) => void): () => void;
}

/** Render one chip state into the button. Exported for tests. With
 *  `idle`, a null state shows the quiet "Check for updates" control (the
 *  status bar) instead of hiding (the home screen's copy). */
export function renderUpdateChip(el: HTMLButtonElement, s: UpdateChipState | null, idle = false): void {
  if (!s) {
    el.hidden = !idle;
    if (idle) {
      el.dataset['state'] = 'idle';
      el.textContent = 'Check for updates';
      el.title = 'Check for a CardMirror update now';
    }
    return;
  }
  el.hidden = false;
  el.dataset['state'] = s.state;
  if (s.state === 'ready') {
    el.textContent = `Update ${s.version} ready — restart to install`;
    el.title = 'Restart CardMirror now to finish installing the update';
  } else {
    el.textContent = `Update ${s.version} available`;
    el.title = 'Open the release page to download the update';
  }
}

/** Wire the chip: initial state pull (late-opened windows), live
 *  subscription, click → the main process picks the action. */
export function initUpdateChip(
  el: HTMLButtonElement,
  host: UpdateChipHost,
  opts?: {
    /** Status bar: when no update is pending, show "Check for updates" and
     *  run this on click. Resolves 'latest' / 'updating' / anything else. */
    idleCheck?: () => Promise<string>;
  },
): () => void {
  const idleCheck = opts?.idleCheck;
  let current: UpdateChipState | null = null;
  let revert: ReturnType<typeof setTimeout> | null = null;
  const render = (s: UpdateChipState | null): void => {
    current = s;
    if (revert) clearTimeout(revert);
    revert = null;
    renderUpdateChip(el, s, !!idleCheck);
  };
  /** A transient idle label ("Checking…", "Up to date"), back to "Check
   *  for updates" after `ms` unless a real update state arrives first. */
  const flash = (text: string, ms: number): void => {
    el.textContent = text;
    if (revert) clearTimeout(revert);
    revert = ms > 0 ? setTimeout(() => render(current), ms) : null;
  };
  el.addEventListener('click', () => {
    if (!current && idleCheck) {
      if (el.dataset['state'] === 'checking') return;
      el.dataset['state'] = 'checking';
      flash('Checking for updates…', 0);
      void idleCheck().then((outcome) => {
        if (current) return; // an update state arrived meanwhile
        el.dataset['state'] = 'idle';
        if (outcome === 'latest') flash('Up to date', 4000);
        else if (outcome === 'updating') flash('Downloading update…', 10 * 60 * 1000);
        else render(null);
      });
      return;
    }
    void host.updateChipAction().catch((err) => {
      console.warn('Update chip action failed:', err);
    });
  });
  const unsubscribe = host.onUpdateChip(render);
  render(null);
  void host
    .getUpdateChipState()
    .then(render)
    .catch(() => {});
  return unsubscribe;
}
