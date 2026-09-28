/**
 * Async serialization path (`serializeNativeAsync` / `gzipAsync`) —
 * used by the editor's debounced journal/autosave writes so the gzip
 * DEFLATE runs off the main thread. The contract is byte-compatibility
 * with the sync path: same input, same output bytes (the two share the
 * envelope builder, so codec-level equality covers the whole pipe).
 */

import { describe, expect, it } from 'vitest';
import { gzip, gzipAsync, gunzip, isGzip } from '../../src/native/codec.js';
import { serializeNativeAsync, parseNative } from '../../src/index.js';
import { schema } from '../../src/schema/index.js';

describe('gzipAsync', () => {
  it('produces byte-identical output to the sync gzip', async () => {
    const input = new TextEncoder().encode(
      JSON.stringify({ pad: 'y'.repeat(50_000), arr: Array.from({ length: 200 }, (_, i) => i) }),
    );
    const syncOut = gzip(input);
    const asyncOut = await gzipAsync(input);
    expect(Buffer.compare(Buffer.from(asyncOut), Buffer.from(syncOut))).toBe(0);
  });

  it('round-trips through gunzip', async () => {
    const input = new TextEncoder().encode('journal payload '.repeat(1000));
    const out = await gzipAsync(input);
    expect(isGzip(out)).toBe(true);
    expect(Buffer.compare(Buffer.from(gunzip(out)), Buffer.from(input))).toBe(0);
  });
});

describe('serializeNativeAsync', () => {
  it('round-trips doc and docId through parseNative', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [
      schema.nodes['paragraph']!.create(null, schema.text('hello async world')),
    ]);
    const bytes = await serializeNativeAsync(doc, { docId: 'test-doc-id' });
    expect(isGzip(bytes)).toBe(true);
    const parsed = parseNative(bytes);
    expect(parsed.doc.eq(doc)).toBe(true);
    expect(parsed.docId).toBe('test-doc-id');
  });
});

describe('serializeNativeAsync — reuse for the journal + autosave pair', () => {
  const para = (t: string) => schema.nodes['paragraph']!.create(null, schema.text(t));
  const thread = (id: string) => ({ id, comments: [] }) as unknown as import('../../src/editor/comments-plugin.js').Thread;

  it('serves the same doc, threads and id from the previous call', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [para('same')]);
    const t = thread('t1');
    const a = serializeNativeAsync(doc, { threads: [t], docId: 'd' });
    const b = serializeNativeAsync(doc, { threads: [t], docId: 'd' });
    expect(b).toBe(a);
  });

  it('treats no threads and an empty thread list alike', () => {
    const doc = schema.nodes['doc']!.createChecked(null, [para('empty')]);
    const a = serializeNativeAsync(doc, { threads: [], docId: 'd' });
    expect(serializeNativeAsync(doc, { docId: 'd' })).toBe(a);
  });

  it('re-serializes when the doc, a thread object or the id changes', async () => {
    const doc = schema.nodes['doc']!.createChecked(null, [para('one')]);
    const t = thread('t1');
    const a = serializeNativeAsync(doc, { threads: [t], docId: 'd' });
    const newDoc = schema.nodes['doc']!.createChecked(null, [para('one')]); // equal, new identity
    expect(serializeNativeAsync(newDoc, { threads: [t], docId: 'd' })).not.toBe(a);
    const b = serializeNativeAsync(newDoc, { threads: [{ ...t } as typeof t], docId: 'd' });
    expect(serializeNativeAsync(newDoc, { threads: [{ ...t } as typeof t], docId: 'd' })).not.toBe(b);
    const c = serializeNativeAsync(newDoc, { docId: 'd' });
    const d = serializeNativeAsync(newDoc, { docId: 'other' });
    expect(d).not.toBe(c);
    expect(parseNative(await d).docId).toBe('other');
  });
});
