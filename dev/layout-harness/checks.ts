/**
 * Layout checks for an open dialog (dev/CI only; see scripts/layout-check.cjs).
 *
 * Real layout, so these run in a browser (Electron in CI), not jsdom. The
 * rules are about what a user can and can't reach, not about pixels:
 *
 *  - off-screen:      the dialog's box leaves the window.
 *  - unreachable:     a button / field is outside the window and no scroll
 *                     area (that is itself on screen) can bring it into view.
 *  - cut-off:         a box clips content (overflow hidden) that holds a
 *                     control, with no way to scroll to it.
 *  - spills-out:      something sticks out past the dialog's edges.
 *  - sideways-scroll: the dialog scrolls horizontally (text didn't wrap).
 *  - tiny-scroll:     a scroll area under 96 px tall: a list you can see
 *                     two rows of at a time.
 *
 * Each violation names the element, so a CI failure says what to fix.
 */

export interface Violation {
  rule: 'off-screen' | 'unreachable' | 'cut-off' | 'spills-out' | 'sideways-scroll' | 'tiny-scroll';
  element: string;
  detail: string;
}

const CONTROL = 'button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [tabindex]:not([tabindex="-1"])';
const TOL = 1; // sub-pixel rounding

/** The open dialogs: role=dialog or a *-dialog box that's visible, outermost only. */
export function openDialogs(): HTMLElement[] {
  const all = [...document.querySelectorAll<HTMLElement>('[role="dialog"], [class*="-dialog"]')].filter(isShown);
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
}

export function checkDialog(dialog: HTMLElement): Violation[] {
  const out: Violation[] = [];
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const d = dialog.getBoundingClientRect();
  const name = describe(dialog);

  if (d.top < -TOL || d.left < -TOL || d.bottom > vh + TOL || d.right > vw + TOL) {
    out.push({
      rule: 'off-screen',
      element: name,
      detail: `box ${box(d)} in a ${vw}×${vh} window`,
    });
  }
  if (dialog.scrollWidth > dialog.clientWidth + TOL && scrolls(dialog, 'x')) {
    out.push({ rule: 'sideways-scroll', element: name, detail: `content ${dialog.scrollWidth}px wide in ${dialog.clientWidth}px` });
  }

  for (const el of [dialog, ...dialog.querySelectorAll<HTMLElement>('*')]) {
    if (!isShown(el)) continue;
    const style = getComputedStyle(el);
    // Scroll areas too short to use.
    if (scrolls(el, 'y') && el.scrollHeight > el.clientHeight + TOL && el.clientHeight < 96) {
      out.push({ rule: 'tiny-scroll', element: describe(el), detail: `${el.clientHeight}px tall, ${el.scrollHeight}px of content` });
    }
    // Clipping boxes that hide a control.
    if (el !== dialog && (style.overflowY === 'hidden' || style.overflowY === 'clip') && el.scrollHeight > el.clientHeight + 4) {
      const r = el.getBoundingClientRect();
      const hidden = [...el.querySelectorAll<HTMLElement>(CONTROL)].find((c) => {
        if (!isShown(c)) return false;
        const cr = c.getBoundingClientRect();
        return cr.height > 0 && (cr.top >= r.bottom - TOL || cr.bottom <= r.top + TOL) && !scrollerBetween(c, el, 'y');
      });
      if (hidden) out.push({ rule: 'cut-off', element: describe(el), detail: `hides ${describe(hidden)}` });
    }
  }

  for (const c of dialog.querySelectorAll<HTMLElement>(CONTROL)) {
    if (!isShown(c)) continue;
    const r = c.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const stop = dialog.parentElement ?? dialog;
    // Up/down: on screen, or inside a scroll area that is itself on screen.
    if (r.bottom > vh + TOL || r.top < -TOL) {
      const s = scrollerBetween(c, stop, 'y');
      if (!s) {
        out.push({ rule: 'unreachable', element: describe(c), detail: `at ${box(r)}, window ${vw}×${vh}, and nothing scrolls to it` });
      } else {
        // The scroll area may itself sit in an outer one (a list inside a
        // settings panel): reachable if some scroll area up the chain is on screen.
        let area: HTMLElement | null = s;
        let onScreen = false;
        while (area && !onScreen) {
          const ar = area.getBoundingClientRect();
          onScreen = ar.bottom <= vh + TOL && ar.top >= -TOL;
          if (!onScreen) area = scrollerBetween(area, stop, 'y');
        }
        if (!onScreen) {
          const sr = s.getBoundingClientRect();
          out.push({ rule: 'unreachable', element: describe(c), detail: `its scroll area ${describe(s)} is off screen (${box(sr)})` });
        }
      }
    }
    // Sideways: inside the dialog and the window, or in a strip that scrolls
    // sideways (natively or with arrow buttons, like Settings' tabs).
    const outside = r.right > vw + TOL || r.left < -TOL || r.right > d.right + 2 || r.left < d.left - 2;
    if (outside) {
      const s = scrollerBetween(c, stop, 'x');
      const sr = s?.getBoundingClientRect();
      if (!s || !sr || sr.right > vw + TOL || sr.left < -TOL) {
        out.push({ rule: 'spills-out', element: describe(c), detail: `at ${box(r)}, dialog ${box(d)}, window ${vw}×${vh}` });
      }
    }
  }
  return dedupe(out);
}

function scrolls(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const v = getComputedStyle(el)[axis === 'x' ? 'overflowX' : 'overflowY'];
  return v === 'auto' || v === 'scroll';
}

/** The nearest ancestor of `el` (up to `stop`) with more content than room
 *  on `axis` that can be scrolled: overflow auto/scroll, or (sideways) a
 *  clipped strip the app scrolls itself. */
function scrollerBetween(el: HTMLElement, stop: HTMLElement, axis: 'x' | 'y'): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const more = axis === 'y' ? p.scrollHeight > p.clientHeight + TOL : p.scrollWidth > p.clientWidth + TOL;
    if (more) {
      if (scrolls(p, axis)) return p;
      if (axis === 'x' && getComputedStyle(p).overflowX !== 'visible') return p;
    }
    if (p === stop) break;
  }
  return null;
}

function isShown(el: HTMLElement): boolean {
  if (el.closest('[hidden]')) return false;
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

function describe(el: HTMLElement): string {
  const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
  const text = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}${text ? ` "${text}"` : ''}`;
}

const box = (r: DOMRect): string => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;

function dedupe(v: Violation[]): Violation[] {
  const seen = new Set<string>();
  return v.filter((x) => {
    const k = `${x.rule}|${x.element}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
