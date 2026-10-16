// @vitest-environment jsdom
/**
 * Right-click → "Expand this pocket to heading level N": the Show heading
 * level filter applied to one heading's subtree, leaving the rest of the
 * outline as it was.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { settings } from '../../src/editor/settings.js';

const h = (type: string, text: string) => schema.nodes[type]!.create({ id: newHeadingId() }, schema.text(text));
const card = (tag: string) =>
  schema.nodes['card']!.create(null, [h('tag', tag), schema.nodes['card_body']!.create(null, schema.text('body'))]);

function makeView(): EditorView {
  const doc = schema.nodes['doc']!.create(null, [
    h('pocket', 'Aff'),
    h('hat', 'Case'),
    h('block', 'Adv 1'),
    card('Aff tag'),
    h('pocket', 'Neg'),
    h('hat', 'DA'),
    h('block', 'Link'),
    card('Neg tag'),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  return new EditorView(container, { state: EditorState.create({ doc }) });
}

const shown = (p: NavigationPanel): string[] =>
  [...(p as unknown as { root: HTMLElement }).root.querySelectorAll<HTMLElement>('.pmd-nav-item')]
    .filter((li) => li.style.display !== 'none' && !li.hidden)
    .map((li) => li.querySelector('.pmd-nav-text')?.textContent ?? li.textContent ?? '')
    .map((t) => t.trim());

function rightClick(p: NavigationPanel, text: string): HTMLElement {
  const li = [...(p as unknown as { root: HTMLElement }).root.querySelectorAll<HTMLElement>('.pmd-nav-item')].find(
    (el) => (el.textContent ?? '').includes(text),
  )!;
  li.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 }));
  return document.querySelector<HTMLElement>('.pmd-nav-context-menu')!;
}

beforeEach(() => settings.set('navMaxLevel', 1));
afterEach(() => settings.set('navMaxLevel', 3));

describe('nav pane: expand one heading to a level', () => {
  it('offers only deeper levels, and expands just that pocket', () => {
    const view = makeView();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const panel = new NavigationPanel(host);
    panel.attach(view);
    expect(shown(panel)).toEqual(['Aff', 'Neg']);

    const menu = rightClick(panel, 'Aff');
    const labels = [...menu.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels.filter((l) => l?.startsWith('Expand'))).toEqual([
      'Expand this pocket to heading level 2',
      'Expand this pocket to heading level 3',
      'Expand this pocket to heading level 4',
    ]);
    [...menu.querySelectorAll('button')].find((b) => b.textContent === 'Expand this pocket to heading level 3')!.click();
    expect(shown(panel)).toEqual(['Aff', 'Case', 'Adv 1', 'Neg']);

    rightClick(panel, 'Aff');
    [...document.querySelectorAll<HTMLButtonElement>('.pmd-nav-context-menu button')]
      .find((b) => b.textContent === 'Expand this pocket to heading level 2')!
      .click();
    expect(shown(panel)).toEqual(['Aff', 'Case', 'Neg']);
    panel.destroy();
    view.destroy();
  });
});
