/**
 * Whole-paragraph selections delete their paragraphs (break included).
 * See whole-paragraph-delete.ts.
 */
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import {
  coversWholeParagraphs,
  deleteWholeParagraphSelection,
  wholeParagraphCutPlugin,
} from '../../src/editor/whole-paragraph-delete.js';

const para = (t: string) => schema.nodes['paragraph']!.create(null, t ? schema.text(t) : undefined);
const body = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const card = (...c: PMNode[]) => schema.nodes['card']!.createChecked(null, c);
const doc = (...c: PMNode[]) => schema.nodes['doc']!.createChecked(null, c);

function textStart(d: PMNode, text: string): number {
  let found = -1;
  d.descendants((n, p) => {
    if (found >= 0) return false;
    if (n.isText && n.text === text) { found = p; return false; }
    return true;
  });
  if (found < 0) throw new Error(`"${text}" not in doc`);
  return found;
}
function selectBlocks(d: PMNode, firstText: string, lastText = firstText): EditorState {
  const from = textStart(d, firstText);
  const to = textStart(d, lastText) + lastText.length;
  const base = EditorState.create({ doc: d, plugins: [wholeParagraphCutPlugin] });
  return base.apply(base.tr.setSelection(TextSelection.create(base.doc, from, to)));
}
function blocks(d: PMNode): string[] {
  const out: string[] = [];
  d.descendants((n) => { if (n.isTextblock) { out.push(`${n.type.name}:${n.textContent}`); return false; } return true; });
  return out;
}
function backspace(state: EditorState): EditorState | null {
  let next: EditorState | null = null;
  const ok = deleteWholeParagraphSelection(state, (tr) => { next = state.apply(tr); });
  return ok ? next : null;
}

describe('coversWholeParagraphs', () => {
  it('true for start-of-paragraph to end-of-paragraph, false for partial', () => {
    const d = doc(para('one two'), para('three four'));
    expect(coversWholeParagraphs(selectBlocks(d, 'one two'))).toBe(true);
    expect(coversWholeParagraphs(selectBlocks(d, 'one two', 'three four'))).toBe(true);
    const s = EditorState.create({ doc: d });
    expect(coversWholeParagraphs(s.apply(s.tr.setSelection(TextSelection.create(d, 2, 6))))).toBe(false);
  });

  it('false for the break-grab shape (ends at the NEXT paragraph start)', () => {
    const d = doc(para('one two'), para('three four'));
    const s = EditorState.create({ doc: d });
    const grab = s.apply(s.tr.setSelection(TextSelection.create(d, 1, textStart(d, 'three four'))));
    expect(coversWholeParagraphs(grab)).toBe(false);
  });
});

describe('Backspace / Delete on a whole-paragraph selection', () => {
  it('removes the paragraph, break included; caret lands at the start of the next', () => {
    const d = doc(para('one'), para('two'), para('three'));
    const next = backspace(selectBlocks(d, 'two'))!;
    expect(blocks(next.doc)).toEqual(['paragraph:one', 'paragraph:three']);
    expect(next.selection.empty).toBe(true);
    expect(next.selection.from).toBe(textStart(next.doc, 'three'));
  });

  it('removes several whole paragraphs at once', () => {
    const d = doc(para('one'), para('two'), para('three'), para('four'));
    const next = backspace(selectBlocks(d, 'two', 'three'))!;
    expect(blocks(next.doc)).toEqual(['paragraph:one', 'paragraph:four']);
  });

  it('the last paragraph: caret lands at the end of the previous one', () => {
    const d = doc(para('one'), para('two'));
    const next = backspace(selectBlocks(d, 'two'))!;
    expect(blocks(next.doc)).toEqual(['paragraph:one']);
    expect(next.selection.from).toBe(textStart(next.doc, 'one') + 3);
  });

  it('a card body paragraph goes; the card keeps its tag', () => {
    const d = doc(card(tag('TAG'), body('alpha'), body('beta')));
    const next = backspace(selectBlocks(d, 'alpha'))!;
    expect(blocks(next.doc)).toEqual(['tag:TAG', 'card_body:beta']);
  });

  it('defers for a partial selection (ordinary delete runs)', () => {
    const d = doc(para('one two'), para('three'));
    const s = EditorState.create({ doc: d });
    const partial = s.apply(s.tr.setSelection(TextSelection.create(d, 2, 5)));
    expect(deleteWholeParagraphSelection(partial)).toBe(false);
  });

  it("defers for a paragraph the schema keeps (a card's tag, the document's only paragraph)", () => {
    expect(deleteWholeParagraphSelection(selectBlocks(doc(card(tag('TAG'), body('b'))), 'TAG'))).toBe(false);
    expect(deleteWholeParagraphSelection(selectBlocks(doc(para('only')), 'only'))).toBe(false);
  });
});

describe('Cut on a whole-paragraph selection', () => {
  it("drops the emptied paragraph after ProseMirror's own cut delete", () => {
    const state = selectBlocks(doc(para('one'), para('two'), para('three')), 'two');
    // What prosemirror-view dispatches on a cut event.
    const next = state.apply(state.tr.deleteSelection().setMeta('uiEvent', 'cut'));
    expect(blocks(next.doc)).toEqual(['paragraph:one', 'paragraph:three']);
    expect(next.selection.from).toBe(textStart(next.doc, 'three'));
  });

  it('leaves a partial cut alone', () => {
    const d = doc(para('one two'), para('three'));
    const s = EditorState.create({ doc: d, plugins: [wholeParagraphCutPlugin] });
    const partial = s.apply(s.tr.setSelection(TextSelection.create(d, 2, 5)));
    const next = partial.apply(partial.tr.deleteSelection().setMeta('uiEvent', 'cut'));
    expect(blocks(next.doc)).toEqual(['paragraph:otwo', 'paragraph:three']);
  });
});
