/**
 * "Click outside to close" for modal backdrops, without the drag-release
 * false positive.
 *
 * A `click` fires on the nearest element containing both the press and the
 * release. So pressing inside a dialog (selecting text in a field) and
 * releasing over the backdrop produced a click whose target IS the
 * backdrop, and every dialog closed mid-selection (dragging a selection to
 * the right edge of the relay URL field closed Settings). A backdrop click
 * now also requires the press to have started on the backdrop.
 */

let lastPressTarget: EventTarget | null = null;
if (typeof document !== 'undefined') {
  // Capture phase, so a handler that stops propagation can't hide a press.
  document.addEventListener('mousedown', (e) => (lastPressTarget = e.target), true);
}

/** Whether `e` is a genuine click on `backdrop` itself: target is the
 *  backdrop, and the press started there too. Clicks with no pointer press
 *  behind them (`detail === 0`: keyboard activation, `element.click()`)
 *  only need the target. */
export function isBackdropClick(e: MouseEvent, backdrop: Element): boolean {
  if (e.target !== backdrop) return false;
  return e.detail === 0 || lastPressTarget === backdrop;
}
