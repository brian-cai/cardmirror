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

/** Run a manual check and report the result in a toast. Resolves when the
 *  check has answered (the download, if any, continues in the background
 *  and ends in the update chip). */
export async function checkForUpdatesNow(): Promise<void> {
  const host = getElectronHost();
  if (!host || isLiteBuild()) {
    showToast(isLiteBuild() ? 'CardMirror Lite never checks for updates.' : 'Updates come with the desktop app.');
    return;
  }
  if (inFlight) return;
  inFlight = true;
  showToast('Checking for updates…');
  try {
    // .catch-equivalent: a main process older than the renderer (dev
    // hot-reload) has no handler, so `invoke` rejects.
    const result = await host.checkForUpdates();
    if (result.status === 'latest') {
      showToast("You're on the latest version.");
    } else if (result.status === 'updating') {
      showToast('Update found — downloading in the background. A button appears in the status bar when it’s ready to install.');
    } else if (result.status === 'dev') {
      showToast('Update checks are only active in packaged builds.');
    } else {
      showToast(`Update check failed: ${result.message ?? 'unknown error'}`);
    }
  } catch (err) {
    showToast(`Update check failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    inFlight = false;
  }
}
