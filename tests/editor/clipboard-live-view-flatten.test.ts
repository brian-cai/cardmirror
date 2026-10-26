// @vitest-environment jsdom
/**
 * Every copy command that builds its own clipboard payload materializes
 * live views (`self_ref`) the way the editor's own copy does (field
 * reports 2026-09-09: "Source section not found in this document" in the
 * speech doc after the outline's Copy / Cut, Copy Current Heading, the
 * discontinuous copy or cut-in-place). A live view holds no cards of its
 * own — its DOM parses back as a live view — so the bare schema
 * serializer those commands used shipped a dangling reference.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { DOMParser as PMDOMParser, type Node as PMNode } from 'prosemirror-model';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { createSelfRefNode, fragmentHasSelfRef } from '../../src/editor/self-transclusion.js';
import { recallLinkedCopy, clearLinkedCopy } from '../../src/editor/clipboard-link-cache.js';
import { serializeRangesForClipboard, clipboardSlice } from '../../src/editor/clipboard-slice.js';

const writeClipboardHtml = vi.fn(async (_html: string, _text: string) => true);
vi.mock('../../src/editor/clipboard-write.js', () => ({
  writeClipboardHtml: (html: string, text: string) => writeClipboardHtml(html, text),
  CLIPBOARD_BUSY_MESSAGE: 'busy',
}));

import { NavigationPanel } from '../../src/editor/nav-panel.js';
import {
  buildSimilarSelectionPlugin,
  setManualShadowSelection,
  similarSelectionKey,
} from '../../src/editor/similar-selection-plugin.js';
import {
  buildCutInPlacePlugin,
  installCutInPlaceContext,
  markCutInPlace,
  CUT_MARKER_ATTR,
} from '../../src/editor/cut-in-place.js';

const block = (text: string, id: string): PMNode => schema.nodes['block']!.create({ id }, schema.text(text));
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.createChecked(null, [
    schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
/** A backfile: the source section, then a "Home" section that holds a
 *  live view of it — the section a debater copies into the speech doc. */
function seed(): PMNode {
  return schema.nodes['doc']!.create(null, [
    block('Source', 'src'),
    card('Src tag', 'source body'),
    block('Home', 'home'),
    createSelfRefNode(schema, 'src', '↳ Source'),
  ]);
}
/** Doc range of the "Home" section: its heading through the live view. */
function homeRange(doc: PMNode): { from: number; to: number } {
  let from = -1;
  let pos = 0;
  doc.forEach((child) => {
    if (from < 0 && child.type.name === 'block' && child.textContent === 'Home') from = pos;
    pos += child.nodeSize;
  });
  if (from < 0) throw new Error('no Home section');
  return { from, to: doc.content.size };
}
function makeView(doc: PMNode, plugins: import('prosemirror-state').Plugin[] = []): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new EditorView(el, { state: EditorState.create({ doc, plugins }) });
}
function parseHtml(html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parseSlice(div);
}
function cardTags(html: string): string[] {
  const out: string[] = [];
  parseHtml(html).content.descendants((n) => {
    if (n.type.name === 'tag') out.push(n.textContent);
    return true;
  });
  return out;
}

afterEach(() => {
  writeClipboardHtml.mockClear();
  clearLinkedCopy();
  installCutInPlaceContext(null);
  document.body.innerHTML = '';
});

describe('the shared clipboard path materializes live views', () => {
  it('clipboardSlice: the view becomes the source section’s cards, re-stamped', () => {
    const view = makeView(seed());
    const slice = clipboardSlice(view, homeRange(view.state.doc));
    expect(fragmentHasSelfRef(slice.content)).toBe(false);
    const tags: string[] = [];
    const ids: string[] = [];
    slice.content.descendants((n) => {
      if (n.type.name === 'tag') {
        tags.push(n.textContent);
        ids.push(String(n.attrs['id']));
      }
      return true;
    });
    expect(tags).toEqual(['Src tag']);
    const sourceId = String(view.state.doc.child(1).firstChild!.attrs['id']);
    expect(ids[0]).not.toBe(sourceId); // no id collision with the source card
    view.destroy();
  });

  it('serializeRangesForClipboard: HTML carries the cards, never a live view; text has the body', () => {
    const view = makeView(seed());
    const { html, text } = serializeRangesForClipboard(view, [homeRange(view.state.doc)]);
    expect(html).not.toContain('pmd-self-ref');
    expect(html).toContain('source body');
    expect(cardTags(html)).toEqual(['Src tag']);
    expect(text).toContain('Home');
    expect(text).toContain('source body');
    view.destroy();
  });

  it('a paste back into the SAME document still restores the live view (link kept, as the editor’s copy does)', () => {
    const view = makeView(seed());
    const other = makeView(seed());
    const { html } = serializeRangesForClipboard(view, [homeRange(view.state.doc)]);
    const pasted = parseHtml(html);
    const recalled = recallLinkedCopy(view, pasted);
    expect(recalled, 'the same view recalls the link-bearing original').not.toBeNull();
    expect(fragmentHasSelfRef(recalled!.content)).toBe(true);
    expect(recallLinkedCopy(other, pasted), 'another document gets the materialized cards').toBeNull();
    view.destroy();
    other.destroy();
  });

  it('a discontinuous copy (several ranges) materializes each range', () => {
    const doc = schema.nodes['doc']!.create(null, [
      block('Source', 'src'),
      card('Src tag', 'source body'),
      block('Home', 'home'),
      createSelfRefNode(schema, 'src', '↳ Source'),
      block('Other', 'other'),
      createSelfRefNode(schema, 'src', '↳ Source again'),
    ]);
    const view = makeView(doc);
    let pos = 0;
    const starts: number[] = [];
    doc.forEach((child) => {
      if (child.type.name === 'block' && child.textContent !== 'Source') starts.push(pos);
      pos += child.nodeSize;
    });
    const ranges = [
      { from: starts[0]!, to: starts[1]! },
      { from: starts[1]!, to: doc.content.size },
    ];
    const { html } = serializeRangesForClipboard(view, ranges);
    expect(html).not.toContain('pmd-self-ref');
    expect(cardTags(html)).toEqual(['Src tag', 'Src tag']);
    view.destroy();
  });
});

describe('the copy commands that build their own payload', () => {
  it('outline Copy heading and contents', async () => {
    const view = makeView(seed(), [buildSimilarSelectionPlugin()]);
    const nav = new NavigationPanel(document.createElement('div'));
    nav.attach(view);
    nav.update(view.state.doc);
    const entries = [...((nav as unknown as Record<string, unknown>)['liEntries'] as Map<HTMLElement, { text?: string }>).values()];
    const home = entries.find((e) => (e.text ?? '').includes('Home'));
    expect(home).toBeDefined();
    await (nav as unknown as { copyHeadingAndContents: (e: unknown) => Promise<void> }).copyHeadingAndContents(home);
    expect(writeClipboardHtml).toHaveBeenCalledTimes(1);
    const [html] = writeClipboardHtml.mock.calls[0]! as [string, string];
    expect(html).not.toContain('pmd-self-ref');
    expect(cardTags(html)).toEqual(['Src tag']);
    view.destroy();
  });

  it('outline Cut heading and contents', async () => {
    const view = makeView(seed(), [buildSimilarSelectionPlugin()]);
    const nav = new NavigationPanel(document.createElement('div'));
    nav.attach(view);
    nav.update(view.state.doc);
    const entries = [...((nav as unknown as Record<string, unknown>)['liEntries'] as Map<HTMLElement, { text?: string }>).values()];
    const home = entries.find((e) => (e.text ?? '').includes('Home'));
    await (nav as unknown as { cutHeadingAndContents: (e: unknown) => Promise<void> }).cutHeadingAndContents(home);
    const [html] = writeClipboardHtml.mock.calls[0]! as [string, string];
    expect(html).not.toContain('pmd-self-ref');
    expect(cardTags(html)).toEqual(['Src tag']);
    expect(view.state.doc.textContent).not.toContain('Home'); // the cut half still happens
    expect(view.state.doc.textContent).toContain('source body'); // the source stays
    view.destroy();
  });

  it('the discontinuous (Cmd-click) copy handler', () => {
    const view = makeView(seed(), [buildSimilarSelectionPlugin()]);
    setManualShadowSelection(view, [homeRange(view.state.doc)]);
    const plugin = similarSelectionKey.get(view.state)!;
    const data = new Map<string, string>();
    const ev = {
      clipboardData: { setData: (k: string, v: string) => data.set(k, v) },
      preventDefault: () => {},
    } as unknown as ClipboardEvent;
    const handled = plugin.props.handleDOMEvents!['copy']!.call(plugin, view, ev);
    expect(handled).toBe(true);
    const html = data.get('text/html')!;
    expect(html).not.toContain('pmd-self-ref');
    expect(cardTags(html)).toEqual(['Src tag']);
    expect(data.get('text/plain')).toContain('source body');
    view.destroy();
  });

  it('cut-in-place’s payload (a shared-document cut)', async () => {
    const view = makeView(seed(), [buildSimilarSelectionPlugin(), buildCutInPlacePlugin()]);
    let written: { html: string; text: string } | null = null;
    installCutInPlaceContext({
      isSessionDoc: () => true,
      docKey: () => 'A',
      viewForDocKey: () => null,
      hasSeenNotice: () => true,
      markNoticeSeen: () => {},
      writeClipboard: async (html, text) => {
        written = { html, text };
        return true;
      },
      clipboardBusyMessage: 'busy',
    });
    expect(await markCutInPlace(view, [homeRange(view.state.doc)])).toBe(true);
    expect(written).not.toBeNull();
    const { html } = written!;
    expect(html).toContain(CUT_MARKER_ATTR); // still recognized as a move by a same-doc paste
    expect(html).not.toContain('pmd-self-ref');
    expect(cardTags(html)).toEqual(['Src tag']);
    view.destroy();
  });
});

describe('no copy or capture path is left on the bare serializer', () => {
  // A drift guard: the commands that put ranges on the clipboard go
  // through the shared helper, and the two capture-side paths that hand
  // a slice to another document (the quick-card palette's file objects,
  // the Send pill's drag) materialize while the source doc is in hand.
  const src = (p: string): string => readFileSync(resolve(process.cwd(), 'src/editor', p), 'utf8');
  it.each([
    ['nav-panel.ts', 'serializeRangesForClipboard('],
    ['index.ts', 'serializeRangesForClipboard(sourceView'],
    ['similar-selection-plugin.ts', 'serializeRangesForClipboard(view, ps.matches)'],
    ['cut-in-place.ts', 'serializeRangesForClipboard(view, ranges)'],
    ['quick-card-search-ui.ts', 'flattenSelfRefsInSlice(\n          fileDoc.slice('],
    ['pairing/send-pill-ui.ts', 'flattenSelfRefsInSlice(srcView.state.doc.slice(item.from, item.to), srcView.state.doc, newHeadingId)'],
  ])('%s', (file, marker) => {
    expect(src(file)).toContain(marker);
  });
  it('the copy commands no longer build payloads with DOMSerializer.fromSchema', () => {
    for (const f of ['nav-panel.ts', 'similar-selection-plugin.ts', 'cut-in-place.ts']) {
      expect(src(f).includes('DOMSerializer.fromSchema('), f).toBe(false);
    }
  });
});
