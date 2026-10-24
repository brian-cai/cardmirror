/**
 * "Unread after marker" decoration.
 *
 * A toggleable review aid (`markUnreadAfterMarker`): when on, every run of a
 * card's body text that falls AFTER a reading-position marker (see
 * `reading-marker.ts`) is tinted red, a visual record of the part of the card
 * you didn't reach in a round. Bounded by the card: a marker only reddens the
 * rest of ITS card, never the next one.
 *
 * Display-only, like read mode's hiding: it's a `Decoration` set, never a doc
 * edit, so it round-trips to nothing and flips off cleanly. The red the
 * marker text itself already carries (`font_color` FF0000) is left alone; this
 * only colors the body that comes after it.
 *
 * Perf: the setting is OFF by default, so `build` bails before walking
 * anything (zero cost for the common case). When on, a doc change maps the
 * existing set and recomputes only the top-level children the change touched
 * (like font-size-class / read mode): a full rebuild was ~15 ms per keystroke
 * on a masterfile. A card's decorations depend only on that card, so the
 * result is the same as a full rebuild.
 */

import { Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { changedRange, expandToTopLevel } from './decoration-range.js';
import { settings } from './settings.js';
import { isMarkerNode, isMarkerText } from '../schema/reading-marker.js';

/** Meta flag on the no-op transaction the settings watcher dispatches when
 *  the toggle flips, so the plugin rebuilds on demand (mirrors read mode's
 *  `PMD_READ_MODE_TOGGLE`). The value is unused; `build` re-reads the setting
 *  itself, so the transaction is purely a rebuild nudge. */
export const MARK_UNREAD_TOGGLE = 'pmdMarkUnreadToggle';

/** The decorations for one doc, ignoring the toggle (the plugin gates on the
 *  setting before calling this). Pure; exported for testing. With a range
 *  (top-level-child aligned, see `expandToTopLevel`), only the cards in it. */
export function computeUnreadDecorations(doc: PMNode, from = 0, to = doc.content.size): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos) => {
    const name = node.type.name;
    // Descend through structural containers (pocket/hat/block) to reach cards.
    if (name !== 'card' && name !== 'analytic_unit') return true;
    // Walk this card's text runs in doc order: find the first marker, then
    // redden every following body run. Tags/cites are skipped, since the
    // feature is about the *body* you didn't read.
    let markerEnd = -1;
    node.descendants((child, offset, parent) => {
      const from = pos + 1 + offset;
      const to = from + child.nodeSize;
      if (isMarkerNode(child)) {
        if (markerEnd < 0) markerEnd = to;
        return false;
      }
      if (!child.isText || !child.text) return true;
      if (markerEnd < 0) {
        if (isMarkerText(child)) markerEnd = to; // "after the marked location"
        return true;
      }
      const inBody = parent?.type.name === 'card_body' || parent?.type.name === 'undertag';
      if (inBody) decos.push(Decoration.inline(from, to, { class: 'pmd-unread' }));
      return true;
    });
    return false; // cards don't nest
  });
  return decos;
}

/** The set plus whether it was built with the setting on, so a doc change
 *  can trust it as a base for an incremental update only when it was (a
 *  toggle that reached this view without its nudge still self-heals with a
 *  full rebuild on the next edit). */
interface UnreadState {
  on: boolean;
  set: DecorationSet;
}

function build(doc: PMNode): UnreadState {
  // OFF (the default) bails before any walk: zero cost for the common case.
  if (!settings.get('markUnreadAfterMarker')) return { on: false, set: DecorationSet.empty };
  return { on: true, set: DecorationSet.create(doc, computeUnreadDecorations(doc)) };
}

export const markUnreadPlugin: Plugin<UnreadState> = new Plugin<UnreadState>({
  state: {
    init(_config, state) {
      return build(state.doc);
    },
    apply(tr, prev, _old, newState) {
      // Rebuild on the toggle nudge; on doc edits (a marker moved / body
      // changed) update incrementally; otherwise (selection-only, unrelated
      // meta) reuse prev.
      if (tr.getMeta(MARK_UNREAD_TOGGLE) !== undefined) return build(newState.doc);
      if (!tr.docChanged) return prev;
      if (!prev.on || !settings.get('markUnreadAfterMarker')) return build(newState.doc);
      const mapped = prev.set.map(tr.mapping, newState.doc);
      const range = changedRange(tr);
      if (!range) return { on: true, set: mapped };
      const zone = expandToTopLevel(newState.doc, range.from, range.to);
      const stale = mapped.find(zone.from, zone.to);
      const fresh = computeUnreadDecorations(newState.doc, zone.from, zone.to);
      return { on: true, set: mapped.remove(stale).add(newState.doc, fresh) };
    },
  },
  props: {
    decorations(state) {
      return markUnreadPlugin.getState(state)?.set;
    },
  },
});
