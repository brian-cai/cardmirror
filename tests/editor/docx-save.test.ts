// @vitest-environment node
/**
 * The save worker rebuilds the doc from JSON before exporting. That round
 * trip must not change what lands in the .docx: same document.xml as a
 * direct export. (Hosts without Worker — this test — take the inline path,
 * which is the fallback the worker failure modes use too.)
 */
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { schema } from '../../src/schema/index.js';
import { toDocx } from '../../src/export/index.js';
import { fromDocxFull } from '../../src/import/index.js';
import { toDocxOffThread } from '../../src/editor/docx-save.js';
import { docJsonText } from '../../src/native/index.js';
import { mixedDoc } from '../collab/_loro-helpers.js';

async function sampleDoc() {
  // A real card + table + paragraphs, exported and re-imported so the doc
  // has exactly the shape an opened file has.
  return (await fromDocxFull(await toDocx(mixedDoc()))).doc;
}

const docXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)['word/document.xml']!);

describe('toDocxOffThread', () => {
  it('writes the same document.xml as toDocx, including after a JSON round trip', async () => {
    const doc = await sampleDoc();
    const direct = docXml(await toDocx(doc, { defaultFont: 'Calibri' }));
    expect(docXml(await toDocxOffThread(doc, { defaultFont: 'Calibri' }))).toBe(direct);
    expect(docXml(await toDocx(schema.nodeFromJSON(JSON.parse(docJsonText(doc))), { defaultFont: 'Calibri' }))).toBe(direct);
  });

  it('the worker builds the same document.xml from the JSON text it is sent', async () => {
    const doc = await sampleDoc();
    const direct = docXml(await toDocx(doc, { defaultFont: 'Calibri' }));
    const replies: unknown[] = [];
    const g = globalThis as unknown as { self?: unknown };
    const had = 'self' in g;
    const prev = g.self;
    const fake = { postMessage: (m: unknown) => replies.push(m), onmessage: null as ((e: { data: unknown }) => void) | null };
    g.self = fake;
    try {
      await import('../../src/editor/docx-save-worker.js');
      fake.onmessage!({ data: { id: 7, docJsonText: docJsonText(doc), opts: { defaultFont: 'Calibri' } } });
      for (let i = 0; i < 200 && replies.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    } finally {
      if (had) g.self = prev;
      else delete g.self;
    }
    const reply = replies[0] as { id: number; ok: boolean; bytes: Uint8Array };
    expect(reply.id).toBe(7);
    expect(reply.ok).toBe(true);
    expect(docXml(reply.bytes)).toBe(direct);
  });
});
