/**
 * Nav pane text size, changed in place (xtgg): ⌘/Ctrl+scroll or ⌘/Ctrl ±
 * with the pointer over the nav pane, the nav right-click menu, and the
 * rebindable Nav Text commands. All of them move the one persisted
 * `navTextScale` setting — the same value Settings → Nav pane text size
 * shows — so a size picked anywhere sticks.
 */
import { settings, sanitizeNavTextScale, NAV_TEXT_SCALE_STEP } from './settings.js';

/** Selector for every nav surface: the single-doc panel and multi-pane rails. */
const NAV_SELECTOR = '.pmd-nav-panel';

let pointerOverNav = false;
let tracking = false;

/** Start tracking whether the pointer is over a nav pane (idempotent). */
export function trackNavHover(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener(
    'pointerover',
    (e) => {
      pointerOverNav = isInNav(e.target);
    },
    { capture: true, passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => {
    pointerOverNav = false;
  });
}

/** Whether the pointer is over a nav pane — the zoom chords resize the nav
 *  text instead of the document then. */
export function isPointerOverNav(): boolean {
  return pointerOverNav;
}

export function isInNav(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NAV_SELECTOR) !== null;
}

/** Move the nav text size `steps` 5% steps (negative = smaller). */
export function stepNavTextScale(steps: number): void {
  settings.set('navTextScale', sanitizeNavTextScale(settings.get('navTextScale') + steps * NAV_TEXT_SCALE_STEP));
}

export function resetNavTextScale(): void {
  settings.set('navTextScale', 100);
}

/** Steps per ⌘/Ctrl+wheel delta: one 5% step per notch, with a trackpad's
 *  many small deltas accumulated. */
const WHEEL_THRESHOLD = 40;
let wheelAccum = 0;

/** Handle a ⌘/Ctrl+wheel (or trackpad pinch) over the nav pane. Returns
 *  whether it was one — the caller then skips the document zoom. Off
 *  (`navScrollResize`), it resizes nothing. */
export function handleNavWheel(e: WheelEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || !isInNav(e.target)) return false;
  // Turned off: still claim it so the document doesn't zoom from the nav,
  // but let it scroll the nav as a plain wheel.
  if (!settings.get('navScrollResize')) return true;
  e.preventDefault();
  wheelAccum += e.deltaY;
  let steps = 0;
  while (wheelAccum <= -WHEEL_THRESHOLD) {
    steps += 1;
    wheelAccum += WHEEL_THRESHOLD;
  }
  while (wheelAccum >= WHEEL_THRESHOLD) {
    steps -= 1;
    wheelAccum -= WHEEL_THRESHOLD;
  }
  if (steps !== 0) stepNavTextScale(steps);
  return true;
}
