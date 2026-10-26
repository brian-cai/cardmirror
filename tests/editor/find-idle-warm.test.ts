// @vitest-environment jsdom
/**
 * Find's idle warmer: a big doc's search text is cached in idle time after
 * it opens (so the first query isn't a cold O(doc) fill), only in a focused
 * window, only above the size threshold, and an edit re-warms just the
 * edited children. Search results never depend on it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '../../src/schema/index.js';
import { findReplaceKey, findReplacePlugin, isFindTextWarm } from '../../src/editor/find-replace-plugin.js';

function makeDoc(texts: string[]) {
  return schema.nodes['doc']!.createChecked(
    null,
    texts.map((t) => schema.nodes['paragraph']!.create(null, schema.text(t))),
  );
}

const texts = Array.from({ length: 40 }, (_, i) => `Card ${i} says Alpha and alpha… then "beta" — ${i}`);

let views: EditorView[] = [];
function mount(minSize: number, docTexts = texts): EditorView {
  const place = document.createElement('div');
  document.body.appendChild(place);
  const view = new EditorView(place, {
    state: EditorState.create({ doc: makeDoc(docTexts), plugins: [findReplacePlugin({ idleWarmMinSize: minSize })] }),
  });
  views.push(view);
  return view;
}

const allWarm = (view: EditorView): boolean => {
  let warm = true;
  view.state.doc.forEach((c) => {
    if (!isFindTextWarm(c, false)) warm = false;
  });
  return warm;
};

function queryMatches(state: EditorState, query: string) {
  const next = state.apply(
    state.tr.setMeta(findReplaceKey, {
      type: 'setQuery',
      query,
      caseSensitive: false,
      wholeWord: false,
      sortMode: 'uncategorized',
      anchor: 0,
      categoryOrder: ['heading', 'tag', 'analytic', 'undertag', 'cite', 'other'],
    }),
  );
  return findReplaceKey.getState(next)!.matches;
}

describe('find idle warmer', () => {
  let focused = true;
  beforeEach(() => {
    vi.useFakeTimers();
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  });
  afterEach(() => {
    for (const v of views) v.destroy();
    views = [];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('warms a big doc once it has been quiet, and re-warms only after edits', async () => {
    const view = mount(1);
    expect(allWarm(view)).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(allWarm(view)).toBe(true);

    const before = view.state.doc;
    view.dispatch(view.state.tr.insertText('ALPHA ', 3));
    const edited = view.state.doc.child(0);
    expect(isFindTextWarm(edited, false)).toBe(false);
    // Unchanged children are the same nodes, still warm.
    expect(view.state.doc.child(1)).toBe(before.child(1));
    expect(isFindTextWarm(view.state.doc.child(1), false)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(isFindTextWarm(view.state.doc.child(0), false)).toBe(true);

    // Same results as a cold search over the same doc.
    const cold = EditorState.create({ doc: makeDoc(view.state.doc.content.content.map((c) => c.textContent)), plugins: [findReplacePlugin()] });
    const warmRes = queryMatches(view.state, 'alpha');
    expect(warmRes.length).toBe(81);
    expect(warmRes).toEqual(queryMatches(cold, 'alpha'));
    expect(queryMatches(view.state, 'alpha...')).toEqual(queryMatches(cold, 'alpha...'));
  });

  it('leaves a doc below the threshold alone', async () => {
    const view = mount(1_000_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.state.doc.childCount).toBe(40);
    view.state.doc.forEach((c) => expect(isFindTextWarm(c, false)).toBe(false));
  });

  it('waits for the window to be focused', async () => {
    focused = false;
    const view = mount(1, texts.map((t) => t + ' unfocused'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(allWarm(view)).toBe(false);
    focused = true;
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(allWarm(view)).toBe(true);
  });

  it('stops when the view is destroyed', async () => {
    const view = mount(1, texts.map((t) => t + ' destroyed'));
    const doc = view.state.doc;
    view.destroy();
    views = views.filter((v) => v !== view);
    await vi.advanceTimersByTimeAsync(5000);
    doc.forEach((c) => expect(isFindTextWarm(c, false)).toBe(false));
  });
});
