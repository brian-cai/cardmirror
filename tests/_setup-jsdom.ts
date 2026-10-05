/**
 * Shared jsdom setup: geometry stubs ProseMirror needs.
 *
 * jsdom implements no layout, and notably ships NO `Range.getClientRects`
 * / `getBoundingClientRect`. ProseMirror reads those whenever it
 * reconciles a selection change (`DOMObserver.flush` →
 * `scrollToSelection` → `coordsAtPos` → `singleRect`), so any test that
 * moves DOM focus while an EditorView exists — e.g. a modal focusing
 * itself — throws `target.getClientRects is not a function` inside a
 * jsdom event listener. Those surface as vitest "unhandled errors"
 * (non-zero exit) even when every assertion passes.
 *
 * Empty rect lists are the honest answer in a layout-free environment:
 * PM treats "no rects" as "nothing to scroll to" and moves on, which is
 * exactly the intended no-op under jsdom.
 */

interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

const ZERO_RECT: RectLike = {
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
};

if (typeof Range !== 'undefined') {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  if (typeof proto['getClientRects'] !== 'function') {
    proto['getClientRects'] = function getClientRects(): RectLike[] {
      return [];
    };
  }
  if (typeof proto['getBoundingClientRect'] !== 'function') {
    proto['getBoundingClientRect'] = function getBoundingClientRect(): RectLike {
      return { ...ZERO_RECT };
    };
  }
}

// Same layout-free gap: jsdom has no `Element.scrollIntoView`. UI code
// calls it after list re-renders (e.g. the palette keeping the active
// row visible); a no-op is the honest jsdom behavior.
if (typeof Element !== 'undefined') {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof proto['scrollIntoView'] !== 'function') {
    proto['scrollIntoView'] = function scrollIntoView(): void {};
  }
}

/**
 * The co-editing binding's identity fast path (patches/loro-prosemirror:
 * cardmirrorIdentitySkip) skips unchanged children without asking Loro.
 * Under test, every skip is re-checked against Loro and a wrong one
 * throws — so every co-editing suite and fuzzer doubles as its proof.
 */
(globalThis as { __CM_VERIFY_SYNC_FASTPATH__?: boolean }).__CM_VERIFY_SYNC_FASTPATH__ = true;
