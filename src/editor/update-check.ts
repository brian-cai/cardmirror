/**
 * "Check for updates" on demand — one flow shared by Settings → General,
 * the home screen's button and the Check for Updates command (command bar /
 * keybinding), so Windows and Linux, which have no menu bar, reach it as
 * easily as the macOS menu item. Desktop only; Lite never contacts the
 * update host.
 */
import { getElectronHost } from './host/index.js';
import { isLiteBuild } from './lite.js';
import { showToast } from './toast.js';

let inFlight = false;

/** Whether this host can check for updates at all. */
export function canCheckForUpdates(): boolean {
  return !!getElectronHost() && !isLiteBuild();
}

export type ManualCheckOutcome = 'latest' | 'updating' | 'dev' | 'error' | 'unavailable' | 'busy';

/** Run a manual check and report the result (toasts unless `quiet` — the
 *  status-bar chip shows its own progress). Resolves when the check has
 *  answered; a download, if any, continues in the background and ends in
 *  the update chip. */

export async function checkForUpdatesNow(opts?: { quiet?: boolean }): Promise<ManualCheckOutcome> {
  const host = getElectronHost();
  if (!host || isLiteBuild()) {
    showToast(isLiteBuild() ? 'CardMirror Lite never checks for updates.' : 'Updates come with the desktop app.');
    return 'unavailable';
  }
  if (inFlight) return 'busy';
  inFlight = true;
  // The status-bar chip shows its own progress; elsewhere, a toast does.
  if (!opts?.quiet) showToast('Checking for updates…');
  try {
    // .catch-equivalent: a main process older than the renderer (dev
    // hot-reload) has no handler, so `invoke` rejects.
    const result = await host.checkForUpdates();
    if (result.status === 'latest') {
      if (!opts?.quiet) showToast("You're on the latest version.");
      return 'latest';
    }
    if (result.status === 'updating') {
      if (!opts?.quiet) {
        showToast('Update found — downloading in the background. A button appears in the status bar when it’s ready to install.');
      }
      return 'updating';
    }
    if (result.status === 'dev') {
      showToast('Update checks are only active in packaged builds.');
      return 'dev';
    }
    showToast(`Update check failed: ${result.message ?? 'unknown error'}`);
    return 'error';
  } catch (err) {
    showToast(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'error';
  } finally {
    inFlight = false;
  }
}
