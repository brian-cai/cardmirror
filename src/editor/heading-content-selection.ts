/**
 * Remembers the selection made by the nav pane's "Select heading and
 * contents", so the find bar can tell it apart from a hand-made highlight.
 *
 * Opening find over a highlight pre-fills the search box with it (Word /
 * Google Docs behavior). Opening find right after "Select heading and
 * contents" instead scopes the search to that heading's subtree, since the
 * user picked a region to search within, not a query.
 *
 * The mark is exact and self-expiring: it matches only while the view's
 * selection is still the one the action made AND the doc is unchanged
 * (same doc object), so any edit or selection change drops it.
 */

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';

const marks = new WeakMap<EditorView, { doc: PMNode; from: number; to: number }>();

/** Record the view's current selection as a heading-and-contents selection. */
export function markHeadingContentSelection(view: EditorView): void {
  const { from, to } = view.state.selection;
  marks.set(view, { doc: view.state.doc, from, to });
}

/** Is the view's selection still the one "Select heading and contents" made? */
export function isHeadingContentSelection(view: EditorView): boolean {
  const mark = marks.get(view);
  if (!mark) return false;
  const { selection, doc } = view.state;
  return !selection.empty && mark.doc === doc && mark.from === selection.from && mark.to === selection.to;
}
