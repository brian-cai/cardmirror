/**
 * Deleting a whole-paragraph selection removes the paragraph(s).
 *
 * A selection that runs from the START of one paragraph to the END of
 * another (a triple-click, or Ctrl/Alt+Shift+Down from a paragraph
 * start) covers those paragraphs completely but not the break after the
 * last one. Plain deletion then leaves an empty paragraph behind — the
 * one thing nobody wants after "select the paragraph, delete it". This
 * module makes Backspace, Delete and Cut on that shape remove the
 * emptied paragraph as well, so whole-paragraph selections act on
 * exactly the paragraphs they cover in both directions: block commands
 * format them (and nothing after), deletion removes them.
 *
 * Typing over the selection is unchanged (replaces in place, paragraph
 * kept). A paragraph the schema won't let go of — a card's tag, the only
 * block in a container, the last paragraph of the document — falls back
 * to today's behavior: its text is cleared and it stays.
 *
 * The deliberate break-grab shape (selection ending at the NEXT
 * paragraph's start, `¶` cue showing) is not this shape and keeps its own
 * handling in `boundary-cursor-keymap.ts` / `type-over-boundary.ts`.
 */

import { Plugin, Selection, TextSelection } from 'prosemirror-state';
import type { Command, EditorState, Transaction } from 'prosemirror-state';

/** Whether the selection covers whole paragraphs: starts at the start of a
 *  textblock and ends at the end of a (possibly different) textblock. */
export function coversWholeParagraphs(state: EditorState): boolean {
  const sel = state.selection;
  if (sel.empty || !(sel instanceof TextSelection)) return false;
  const { $from, $to } = sel;
  return (
    $from.parent.isTextblock &&
    $from.parentOffset === 0 &&
    $to.parent.isTextblock &&
    $to.parentOffset === $to.parent.content.size
  );
}

/**
 * After the selection's content is gone (`tr` already holds that delete),
 * remove the textblock the deletion collapsed into if it is now empty and
 * the schema lets its parent drop it. The caret lands where the paragraph
 * was: the start of the one that followed it, or the end of the one before
 * when nothing follows. Returns false (tr untouched) when nothing to do.
 */
export function dropEmptiedParagraph(tr: Transaction, pos: number): boolean {
  const $pos = tr.doc.resolve(pos);
  const block = $pos.parent;
  if (!block.isTextblock || block.content.size !== 0) return false;
  const depth = $pos.depth;
  if (depth === 0) return false;
  const parent = $pos.node(depth - 1);
  const index = $pos.index(depth - 1);
  // Never empty a container: the last block in the document (or in a
  // card / unit) stays, cleared, so there is always somewhere to type.
  if (parent.childCount <= 1) return false;
  if (!parent.canReplace(index, index + 1)) return false;
  const before = $pos.before(depth);
  const after = $pos.after(depth);
  tr.delete(before, after);
  tr.setSelection(Selection.near(tr.doc.resolve(before), 1));
  return true;
}

/** Backspace / Delete on a whole-paragraph selection: delete it, then drop
 *  the emptied paragraph. Defers (false) for every other shape, so the
 *  rest of the delete chain runs as before. */
export const deleteWholeParagraphSelection: Command = (state, dispatch) => {
  if (!coversWholeParagraphs(state)) return false;
  const from = state.selection.from;
  let tr: Transaction;
  try {
    tr = state.tr.deleteSelection();
  } catch {
    return false;
  }
  // Only claim the key when the paragraph actually goes; a paragraph the
  // schema keeps (tag, lone block) is left to the ordinary delete so its
  // other guards still apply.
  if (!dropEmptiedParagraph(tr, tr.mapping.map(from))) return false;
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
};

/**
 * Cut goes through ProseMirror's own clipboard handler (which writes the
 * clipboard, then dispatches a `deleteSelection` tagged `uiEvent: 'cut'`).
 * This plugin watches for that transaction and, when the selection it cut
 * covered whole paragraphs, appends the paragraph drop — same result as
 * Backspace, one undo step.
 */
export const wholeParagraphCutPlugin = new Plugin({
  appendTransaction(trs, oldState, newState) {
    const cut = trs.find((t) => t.getMeta('uiEvent') === 'cut' && t.docChanged);
    if (!cut || trs.length !== 1) return null;
    if (!coversWholeParagraphs(oldState)) return null;
    const tr = newState.tr;
    const pos = cut.mapping.map(oldState.selection.from);
    return dropEmptiedParagraph(tr, pos) ? tr : null;
  },
});
