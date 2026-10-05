// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { checkDocCached, docJsonText, parseNative, serializeNative } from '../src/native/index.js';
import { schema } from '../src/schema/index.js';
import { mixedDoc } from './collab/_loro-helpers.js';

describe('native save caches', () => {
  it('docJsonText is exactly JSON.stringify(doc.toJSON()), before and after edits', () => {
    let state = EditorState.create({ doc: mixedDoc() });
    expect(docJsonText(state.doc)).toBe(JSON.stringify(state.doc.toJSON()));
    state = state.apply(state.tr.insertText(' more', 5));
    expect(docJsonText(state.doc)).toBe(JSON.stringify(state.doc.toJSON()));
    const empty = schema.nodes['doc']!.create();
    expect(docJsonText(empty)).toBe(JSON.stringify(empty.toJSON()));
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
