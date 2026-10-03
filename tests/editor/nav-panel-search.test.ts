// @vitest-environment jsdom
/**
 * The nav pane's search bar: the query filters/highlights the outline IN
 * PLACE. Options (persisted settings): which heading level to search
 * (Pocket/Hat/Block/Tag/All), "Hide non-matches" (outline narrows to
 * matches plus their ancestors) and "Search content" (a heading also
 * matches when text under it contains the query).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { settings } from '../../src/editor/settings.js';

const h = (type: string, text: string): PMNode =>
  schema.nodes[type]!.create({ id: newHeadingId() }, schema.text(text));
const card = (tag: string, body: string): PMNode =>
  schema.nodes['card']!.createChecked(null, [
    h('tag', tag),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);

function makeView(children: PMNode[]): EditorView {
  const doc = schema.nodes['doc']!.create(null, children);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, { state: EditorState.create({ doc }) });
}

const DOC = (): PMNode[] => [
  h('pocket', '1AC'),
  h('hat', 'Inherency'),
  h('block', 'Warming Advantage'),
  card('Warming causes extinction', 'Sea levels rise'),
  h('block', 'Economy Advantage'),
  card('Decline causes war', 'Trade collapses'),
  h('hat', 'Solvency'),
  h('block', 'Warming — Extensions'),
  card('They don’t solve', 'No carbon tax'),
];

function rootOf(panel: NavigationPanel): HTMLElement {
  return (panel as unknown as { root: HTMLElement }).root;
}

function search(panel: NavigationPanel, q: string): HTMLInputElement {
  const input = rootOf(panel).querySelector<HTMLInputElement>('.pmd-nav-search-input')!;
  input.value = q;
  input.dispatchEvent(new Event('input'));
  return input;
}

/** Rendered outline rows as "level:text". */
function rows(panel: NavigationPanel): string[] {
  return [...rootOf(panel).querySelectorAll('.pmd-nav-list .pmd-nav-item')].map((li) => {
    const level = /pmd-nav-level-(\d)/.exec(li.className)![1];
    return `${level}:${li.querySelector('.pmd-nav-label')!.textContent}`;
  });
}

function hits(panel: NavigationPanel): string[] {
  return [...rootOf(panel).querySelectorAll('.pmd-nav-search-hit .pmd-nav-label')].map(
    (el) => el.textContent ?? '',
  );
}

let view: EditorView;
let panel: NavigationPanel;

function open(): void {
  view = makeView(DOC());
  panel = new NavigationPanel(document.createElement('div'));
  panel.attach(view);
  panel.setSearchMode(true);
}

beforeEach(() => {
  settings.set('navMaxLevel', 3);
  settings.set('navSearchLevel', 0);
  settings.set('navSearchHideNonMatches', true);
  settings.set('navSearchContent', false);
});
afterEach(() => {
  panel.destroy();
  view.destroy();
});

describe('nav pane search', () => {
  it('keeps the level buttons and outline — an empty query changes nothing', () => {
    open();
    const header = rootOf(panel).querySelector('header')!;
    expect(header.querySelector('.pmd-nav-level-group')).not.toBeNull();
    expect(header.querySelector('.pmd-nav-search-input')).not.toBeNull();
    expect(rows(panel)).toEqual([
      '1:1AC',
      '2:Inherency',
      '3:Warming Advantage',
      '3:Economy Advantage',
      '2:Solvency',
      '3:Warming — Extensions',
    ]);
  });

  it('hide non-matches: the outline narrows to matches plus their ancestors', () => {
    open();
    search(panel, 'warming');
    expect(rows(panel)).toEqual([
      '1:1AC',
      '2:Inherency',
      '3:Warming Advantage',
      '4:Warming causes extinction', // a tag match shows past the level filter
      '2:Solvency',
      '3:Warming — Extensions',
    ]);
    expect(hits(panel)).toEqual([
      'Warming Advantage',
      'Warming causes extinction',
      'Warming — Extensions',
    ]);
    expect(rootOf(panel).querySelector('.pmd-nav-search-hit mark')!.textContent).toBe('Warming');
    expect(rootOf(panel).querySelector('.pmd-nav-search-status')!.textContent).toBe('3 matches');
  });

  it('with hide non-matches off, the whole outline stays and matches are highlighted', () => {
    settings.set('navSearchHideNonMatches', false);
    open();
    search(panel, 'economy');
    expect(rows(panel)).toEqual([
      '1:1AC',
      '2:Inherency',
      '3:Warming Advantage',
      '3:Economy Advantage',
      '2:Solvency',
      '3:Warming — Extensions',
    ]);
    expect(hits(panel)).toEqual(['Economy Advantage']);
  });

  it('the level dropdown limits the search to one level', () => {
    settings.set('navSearchLevel', 3);
    open();
    search(panel, 'warming');
    expect(hits(panel)).toEqual(['Warming Advantage', 'Warming — Extensions']);
    settings.set('navSearchLevel', 4);
    expect(hits(panel)).toEqual(['Warming causes extinction']);
    const select = rootOf(panel).querySelector<HTMLSelectElement>('.pmd-nav-search-level')!;
    expect(select.value).toBe('4');
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    expect(settings.get('navSearchLevel')).toBe(2);
    expect(hits(panel)).toEqual([]);
  });

  it('search content credits the nearest heading at the searched level', () => {
    settings.set('navSearchLevel', 3);
    settings.set('navSearchContent', true);
    open();
    search(panel, 'carbon');
    // "No carbon tax" sits in a card under the "Warming — Extensions" block.
    expect(hits(panel)).toEqual(['Warming — Extensions']);
    expect(rootOf(panel).querySelector('.pmd-nav-search-content-hit')).not.toBeNull();
    // Off: body text is not searched.
    settings.set('navSearchContent', false);
    expect(hits(panel)).toEqual([]);
  });

  it('with search content, text in a tag counts as content of the block when tags are not searched', () => {
    settings.set('navSearchLevel', 3);
    settings.set('navSearchContent', true);
    open();
    search(panel, 'extinction');
    expect(hits(panel)).toEqual(['Warming Advantage']);
  });

  it('matches straight quotes against curly ones', () => {
    open();
    search(panel, "don't");
    expect(hits(panel)).toEqual(['They don’t solve']);
  });

  it('skeleton rows are real outline rows — clicking one jumps to it', () => {
    open();
    search(panel, 'extensions');
    const solvency = [...rootOf(panel).querySelectorAll<HTMLElement>('.pmd-nav-item')].find(
      (li) => li.textContent === 'Solvency',
    )!;
    solvency.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
    expect(view.state.selection.$from.parent.textContent).toBe('Solvency');
  });

  it('Enter jumps to the highlighted match; ArrowDown moves the highlight', () => {
    open();
    const input = search(panel, 'advantage');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(view.state.selection.$from.parent.textContent).toBe('Economy Advantage');
  });

  it('re-runs the query when the document changes', () => {
    open();
    search(panel, 'solvency');
    expect(hits(panel)).toEqual(['Solvency']);
    view.dispatch(view.state.tr.insert(view.state.doc.content.size, h('block', 'Solvency Deficit')));
    panel.update(view.state.doc);
    expect(hits(panel)).toEqual(['Solvency', 'Solvency Deficit']);
  });

  it('closing the bar restores the plain outline; the query only applies while open', () => {
    open();
    search(panel, 'economy');
    panel.setSearchMode(false);
    expect(hits(panel)).toEqual([]);
    expect(rows(panel)).toHaveLength(6);
  });

  it('Escape clears the query, then closes the bar', () => {
    open();
    const input = search(panel, 'warming');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(input.value).toBe('');
    expect(hits(panel)).toEqual([]);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(rootOf(panel).classList.contains('pmd-nav-searching')).toBe(false);
  });

  it('the header × closes the search, not the pane, while searching', () => {
    view = makeView(DOC());
    let paneClosed = false;
    panel = new NavigationPanel(document.createElement('div'), {
      onClose: () => (paneClosed = true),
    });
    panel.attach(view);
    panel.setSearchMode(true);
    const close = rootOf(panel).querySelector<HTMLButtonElement>(
      '.pmd-nav-close:not(.pmd-nav-search-btn)',
    )!;
    expect(close.title).toBe('Close search');
    close.click();
    expect(rootOf(panel).classList.contains('pmd-nav-searching')).toBe(false);
    expect(paneClosed).toBe(false);
    close.click();
    expect(paneClosed).toBe(true);
  });
});
