/**
 * App-wide guards on every webContents (Electron security checklist §§ 5, 13,
 * 14, 15): installed once, so a window added later can't forget them.
 *
 * - New windows: never. `window.open` / `target="_blank"` links (footnote and
 *   Settings links use them) would otherwise open the web page in an Electron
 *   window with this app's preload; http(s) and mailto go to the user's
 *   browser instead, everything else is dropped.
 * - Navigation: only within the app's own pages (the packaged renderer
 *   folder, or the dev server in a dev run). A link or a script can't swap
 *   the app for a remote page that would inherit its IPC.
 * - `<webview>`: refused outright; the app doesn't use one.
 * - Permissions: only what the app uses (microphone for voice, clipboard,
 *   fullscreen, notifications), and only for the app's own pages.
 */
import type { App, Session, Shell, WebContents } from 'electron';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export interface AppOrigins {
  /** Dev server origin, honoured only in an unpackaged (dev) run. */
  devServerUrl: string | null;
  /** Folder holding the packaged renderer's pages. */
  rendererDir: string;
}

/** Whether `url` is one of the app's own pages. */
export function isAppUrl(url: string, origins: AppOrigins): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (origins.devServerUrl) {
    const dev = new URL(origins.devServerUrl);
    if (u.origin === dev.origin) return true;
  }
  if (u.protocol !== 'file:') return false;
  let file: string;
  try {
    file = path.resolve(fileURLToPath(u));
  } catch {
    return false;
  }
  const root = path.resolve(origins.rendererDir);
  return file === root || file.startsWith(root + path.sep);
}

/** URLs the app may hand to the OS browser / mail client. */
export function isExternalOpenable(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url);
}

const ALLOWED_PERMISSIONS = new Set([
  'media', // microphone (voice); the handler below refuses video
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'notifications',
]);

/** Permission decision for one request (pure; exported for tests). */
export function permissionAllowed(
  permission: string,
  requestingUrl: string,
  origins: AppOrigins,
  mediaTypes?: readonly string[],
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (!isAppUrl(requestingUrl, origins)) return false;
  if (permission === 'media' && mediaTypes && mediaTypes.some((t) => t !== 'audio')) return false;
  return true;
}

export function installWebHardening(app: App, shell: Shell, origins: AppOrigins): void {
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalOpenable(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (isAppUrl(url, origins)) return;
      event.preventDefault();
      if (isExternalOpenable(url)) void shell.openExternal(url);
    });
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url, origins)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

export function installPermissionPolicy(session: Session, origins: AppOrigins): void {
  session.setPermissionRequestHandler((wc, permission, callback, details) => {
    const url = (details as { requestingUrl?: string }).requestingUrl ?? wc.getURL();
    const mediaTypes = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(permissionAllowed(permission, url, origins, mediaTypes));
  });
  session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    // A file:// page reports its origin as just "file://", which says
    // nothing about WHICH file; judge by the page's full URL instead.
    const url =
      (details as { requestingUrl?: string }).requestingUrl ?? wc?.getURL() ?? requestingOrigin;
    return permissionAllowed(permission, url, origins);
  });
}
