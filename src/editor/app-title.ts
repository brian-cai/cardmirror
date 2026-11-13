/**
 * The app's name in window titles (xtgg): "CardMirror (BCai's build)", so
 * the title bar, the taskbar / Mission Control / Window menu and Switch
 * Window all say which CardMirror this is. Lite keeps plain "CardMirror".
 *
 * The installed app itself stays "CardMirror" (productName / appId):
 * renaming it would move userData and break installing on top of the
 * original build. Everything that writes or parses a window title goes
 * through here so the suffix and the strippers can't drift apart.
 */
import { BUILD_LABEL } from './install-info.js';
import { isLiteBuild } from './lite.js';

/** "CardMirror (BCai's build)", or "CardMirror" in Lite. */
export function appTitle(): string {
  return isLiteBuild() ? 'CardMirror' : `CardMirror (${BUILD_LABEL})`;
}

/** `${name} — CardMirror (BCai's build)`, or just the app title when there
 *  is no name. */
export function windowTitle(name?: string | null): string {
  return name ? `${name} — ${appTitle()}` : appTitle();
}

/** A window title's own part: the doc name(s) with the app suffix removed,
 *  '' for a bare app title. Accepts either build's suffix (a title handed
 *  over from another window or an older version). */
export function stripAppTitle(title: string): string {
  const t = title.trim();
  if (isBareAppTitle(t)) return '';
  return t.replace(/\s*[—-]\s*CardMirror(?:\s+Lite)?(?:\s*\([^()]*\))?$/, '').trim();
}

function isBareAppTitle(t: string): boolean {
  return /^CardMirror(?:\s+Lite)?(?:\s*\([^()]*\))?$/.test(t);
}
