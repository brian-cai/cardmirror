// @vitest-environment jsdom
/**
 * Headings that arrive via sync fold to the pane's depth. The fold is deferred
 * to the next render (a partner's batches arrive several times a second, and
 * folding synchronously walked the doc + rebuilt the outline for each), but it
 * must still run before that render refreshes `lastSeenIds`, so the new
 * headings are still recognized as new.
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { type Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';

const pocket = (text: string, id: string): PMNode => schema.nodes['pocket']!.create({ id }, schema.text(text));
const hat = (text: string, id: string): PMNode => schema.nodes['hat']!.create({ id }, schema.text(text));

function setup(children: PMNode[]) {
  const doc = schema.nodes['doc']!.create(null, children);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view = new EditorView(el, { state: EditorState.create({ doc }) });
  const nav = new NavigationPanel(document.createElement('div'));
  nav.attach(view);
  nav.update(view.state.doc);
  return { view, nav };
}
const collapsed = (nav: NavigationPanel): Set<string> =>
  (nav as unknown as { collapsed: Set<string> }).collapsed;

describe('NavigationPanel — deferred fold of sync-arrived headings', () => {
  it('folds headings new since the last render, at the next render', () => {
    const { view, nav } = setup([pocket('One', 'p1'), hat('One-a', 'h1')]);
    nav.setMaxLevel(1);
    expect(collapsed(nav).has('p1')).toBe(true);
    // The user opens the existing pocket; that must survive the fold.
    collapsed(nav).delete('p1');

    const end = view.state.doc.content.size;
    view.dispatch(view.state.tr.insert(end, [pocket('Two', 'p2'), hat('Two-a', 'h2')]));
    nav.foldNewHeadingsOnNextRender();
    expect(collapsed(nav).has('p2')).toBe(false); // deferred: nothing yet

    nav.update(view.state.doc);
    expect(collapsed(nav).has('p2')).toBe(true);
    expect(collapsed(nav).has('p1')).toBe(false);
  });

  it('a render without the flag leaves new headings as they are', () => {
    const { view, nav } = setup([pocket('One', 'p1'), hat('One-a', 'h1')]);
    nav.setMaxLevel(1);
    const end = view.state.doc.content.size;
    view.dispatch(view.state.tr.insert(end, [pocket('Two', 'p2'), hat('Two-a', 'h2')]));
    nav.update(view.state.doc);
    expect(collapsed(nav).has('p2')).toBe(false);
  });
});
