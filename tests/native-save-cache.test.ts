// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { gunzipSync } from 'fflate';
import { checkDocCached, docJsonBytes, docJsonText, parseNative, serializeNative } from '../src/native/index.js';
import { schema } from '../src/schema/index.js';
import { docOf, mixedDoc, para } from './collab/_loro-helpers.js';

describe('native save caches', () => {
  it('docJsonText is exactly JSON.stringify(doc.toJSON()), before and after edits', () => {
    let state = EditorState.create({ doc: mixedDoc() });
    expect(docJsonText(state.doc)).toBe(JSON.stringify(state.doc.toJSON()));
    state = state.apply(state.tr.insertText(' more', 5));
    expect(docJsonText(state.doc)).toBe(JSON.stringify(state.doc.toJSON()));
    const empty = schema.nodes['doc']!.create();
    expect(docJsonText(empty)).toBe(JSON.stringify(empty.toJSON()));
  });

  it('docJsonBytes is exactly the UTF-8 of JSON.stringify(doc.toJSON()), before and after edits', () => {
    const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
    let state = EditorState.create({ doc: docOf(para('Caf\u00e9 \u2014 \u{1F525} na\u00efve'), ...mixedDoc().content.content) });
    expect(docJsonBytes(state.doc)).toEqual(utf8(JSON.stringify(state.doc.toJSON())));
    state = state.apply(state.tr.insertText(' \u00fcber \u{1F600}', 5));
    expect(docJsonBytes(state.doc)).toEqual(utf8(JSON.stringify(state.doc.toJSON())));
    const empty = schema.nodes['doc']!.create();
    expect(docJsonBytes(empty)).toEqual(utf8(JSON.stringify(empty.toJSON())));
  });

  it('serializeNative envelope is byte-identical to JSON.stringify of the whole file', () => {
    let doc = docOf(para('\u00c9t\u00e9 \u{1F4A5}'), ...mixedDoc().content.content);
    const threads = [{ id: 't1', comments: [{ id: 't1', author: 'Z\u00f6e', initials: 'Z', date: '2026-05-15T20:00:00.000Z', text: 'ok \u2713', kind: 'human' as const, parentId: null }] }];
    for (let pass = 0; pass < 2; pass++) {
      const bytes = gunzipSync(serializeNative(doc, { threads, docId: 'doc-1', appVersion: 'CardMirror 9' }));
      const head = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      const expected = JSON.stringify({
        format: head['format'],
        formatVersion: head['formatVersion'],
        createdBy: 'CardMirror 9',
        createdAt: head['createdAt'],
        doc: doc.toJSON(),
        threads,
        docId: 'doc-1',
      });
      expect(bytes).toEqual(new TextEncoder().encode(expected));
      // Second pass: the same blocks come from the byte cache, one is new.
      doc = EditorState.create({ doc }).apply(EditorState.create({ doc }).tr.insertText('\u00df', 3)).doc;
    }
  });

  it('checkDocCached rejects an invalid doc like check() does', () => {
    const doc = mixedDoc();
    expect(() => checkDocCached(doc)).not.toThrow();
    // A card with no tag is invalid content.
    const bad = schema.nodes['doc']!.create(null, [schema.nodes['card']!.create(null, [])]);
    expect(() => bad.check()).toThrow();
    expect(() => checkDocCached(bad)).toThrow();
  });

  it('serializeNative still round-trips', () => {
    const doc = mixedDoc();
    expect(parseNative(serializeNative(doc)).doc.eq(doc)).toBe(true);
  });
});
