// @vitest-environment jsdom

/**
 * Nav pane "Select heading and contents" → Ctrl/Cmd-F opens the find bar
 * scoped to that heading's subtree (the user picked a region to search
 * within). A hand-made highlight instead pre-fills the query; see
 * find-bar-scope-default.test.ts.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { NavigationPanel } from '../../src/editor/nav-panel.js';
import { buildSimilarSelectionPlugin } from '../../src/editor/similar-selection-plugin.js';
import { findReplacePlugin, findReplaceKey } from '../../src/editor/find-replace-plugin.js';
import { FindReplaceBar } from '../../src/editor/find-replace-ui.js';
import { isHeadingContentSelection } from '../../src/editor/heading-content-selection.js';
import { settings } from '../../src/editor/settings.js';

function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}

function setup() {
  const doc = schema.nodes['doc']!.create(null, [
    card('Tag A', 'warming is bad'),
    card('Tag B', 'warming is good'),
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const view = new EditorView(container, {
    state: EditorState.create({ doc, plugins: [buildSimilarSelectionPlugin(), findReplacePlugin()] }),
  });
  const nav = new NavigationPanel(document.createElement('div'));
  nav.attach(view);
  nav.update(view.state.doc);
  return { view, nav };
}

function selectHeadingAndContents(nav: NavigationPanel, label: string): void {
  const entries = [
    ...((nav as unknown as Record<string, unknown>)['liEntries'] as Map<HTMLElement, unknown>).values(),
  ];
  const entry = entries.find((e) => ((e as { text?: string }).text ?? '').includes(label));
  if (!entry) throw new Error(`no nav entry labeled "${label}"`);
  (nav as unknown as { selectHeadingAndContents: (e: unknown) => void }).selectHeadingAndContents(entry);
}

beforeEach(() => {
  document.body.innerHTML = '';
  settings.set('findRememberLastQuery', false);
  settings.set('findLastQuery', '');
  settings.set('findResultsExpanded', false);
});

describe('nav "Select heading and contents" then find', () => {
  it('opens find scoped to the selected subtree', () => {
    const { view, nav } = setup();
    selectHeadingAndContents(nav, 'Tag A');
    expect(isHeadingContentSelection(view)).toBe(true);
    const { from, to } = view.state.selection;

    new FindReplaceBar(() => view).open({ mode: 'find', sortMode: 'categorized' });
    const toggle = document.querySelector<HTMLInputElement>('.pmd-find-scope-toggle input')!;
    const input = document.querySelector<HTMLInputElement>('.pmd-find-input')!;
    expect(toggle.checked).toBe(true);
    expect(input.value).toBe('');
    expect(findReplaceKey.getState(view.state)!.scope).toEqual({ from, to });
  });
});
