/**
 * Window sleep: which idle windows to put to sleep.
 *
 * Every document is its own window, and each window is a whole renderer
 * (130–200 MB for an ordinary file, ~570 MB for a big one, measured
 * 2026-10-06). With 8–10 files open that's gigabytes on a student laptop
 * that also runs a browser and a call. Idle windows barely use the CPU —
 * memory is the cost — so a window nobody has touched for a while hands
 * main a snapshot of its document (bytes, unsaved flag, scroll, caret),
 * shows a screenshot of itself on a tiny placeholder page while its
 * renderer is released, and reloads from the snapshot the moment it's
 * focused again.
 *
 * This module is the pure policy; main.ts owns the windows, the snapshot
 * handshake and the placeholder page. Pure so it's unit-testable without
 * Electron.
 */

/** How often main looks for windows to put to sleep. */
export const SLEEP_CHECK_MS = 60_000;
/** A window that doesn't answer a sleep request within this stays awake. */
export const SLEEP_REPLY_TIMEOUT_MS = 20_000;
/** A woken window that never reports back is treated as awake after this. */
export const WAKE_TIMEOUT_MS = 30_000;

export type SleepPhase = 'awake' | 'requesting' | 'asleep' | 'waking';

export interface SleepCandidate {
  id: number;
  phase: SleepPhase;
  focused: boolean;
  /** Last time the window was focused or lost focus (ms). */
  lastActiveAt: number;
  /** Never sleeps: the speech doc, a live co-editing session, the timer
   *  pop-out — things that must keep running or receiving. */
  exempt: boolean;
}

/** Windows to ask to sleep now: awake, not focused, not exempt, and idle
 *  for at least `minutes`. `minutes <= 0` turns sleep off. */
export function pickWindowsToSleep(windows: readonly SleepCandidate[], now: number, minutes: number): number[] {
  if (!(minutes > 0)) return [];
  const idleMs = minutes * 60_000;
  return windows
    .filter((w) => w.phase === 'awake' && !w.focused && !w.exempt && now - w.lastActiveAt >= idleMs)
    .map((w) => w.id);
}

/** Sanitize the renderer-reported setting (minutes; 0 = off). */
export function sanitizeSleepMinutes(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 15;
  return Math.max(0, Math.min(24 * 60, n));
}

/** The page a resting window shows: its screenshot and title, nothing
 *  else. Loaded as a data: URL ON PURPOSE — a different site from the
 *  editor (dev server / file://), so Chromium gives it a fresh renderer
 *  process and the editor's process exits, returning its memory. (A page
 *  from the app's own origin reused the same process and freed almost
 *  nothing.) Focusing the window wakes it; the page talks to no one. */
export function sleepPageHtml(title: string, image: string): string {
  const esc = (t: string): string =>
    t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const img = image.startsWith('data:image/') ? `<img id="shot" alt="" src="${image}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #f4f4f2; --fg: #2a2a2a; --pill: rgba(255,255,255,0.92); --pill-border: rgba(0,0,0,0.12); }
@media (prefers-color-scheme: dark) { :root { --bg: #1e1f22; --fg: #e8e8e8; --pill: rgba(40,41,45,0.92); --pill-border: rgba(255,255,255,0.14); } }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); overflow: hidden; cursor: default;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
#shot { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: top left; filter: saturate(0.85); }
#pill { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); padding: 5px 12px; border-radius: 999px;
  background: var(--pill); border: 1px solid var(--pill-border); box-shadow: 0 2px 10px rgba(0,0,0,0.12); white-space: nowrap; }
</style></head><body>${img}<div id="pill">Resting to save memory \u2014 click to resume</div></body></html>`;
}
