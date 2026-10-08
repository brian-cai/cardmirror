/** Open cache bytes (src/import/open-cache-codec.ts). */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fromDocxFull, toDocx } from '../../src/index.js';
import { decodeOpenResult, encodeOpenResult, sha256Hex } from '../../src/import/open-cache-codec.js';
import { schema, newHeadingId } from '../../src/schema/index.js';

/** A small file with the shapes a debate file has: headings, a card with a
 *  cite and underlined / highlighted / emphasized text. */
async function sampleDocx(): Promise<Uint8Array> {
  const n = schema.nodes;
  const m = schema.marks;
  const doc = n['doc']!.createChecked(null, [
    n['pocket']!.create({ id: newHeadingId() }, schema.text('2AC')),
    n['block']!.create({ id: newHeadingId() }, schema.text('AT: Politics DA')),
    n['card']!.createChecked(null, [
      n['tag']!.create({ id: newHeadingId() }, schema.text('Single payer is popular')),
      n['cite_paragraph']!.create(null, [schema.text('Smith 26', [m['cite_mark']!.create()]), schema.text(', Professor')]),
      n['card_body']!.create(null, [
        schema.text('Polling shows '),
        schema.text('broad support', [m['underline_mark']!.create(), m['highlight']!.create({ color: 'cyan' })]),
        schema.text(' and '),
        schema.text('rising', [m['emphasis_mark']!.create()]),
      ]),
    ]),
  ]);
  return toDocx(doc, {});
}

describe('open cache codec', () => {
  it('round-trips a real Word import exactly', async () => {
    const bytes = await sampleDocx();
    const full = await fromDocxFull(bytes);
    const back = decodeOpenResult(encodeOpenResult(full));
    expect(full.doc.textContent).toContain('broad support');
    expect(back.doc.eq(full.doc)).toBe(true);
    expect(back.threads).toEqual(full.threads);
    expect(back.docId).toBe(full.docId);
  });

  it('rejects another format version and a doc the schema refuses', () => {
    const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
    expect(() => decodeOpenResult(enc({ format: 99, doc: { type: 'doc' } }))).toThrow();
    expect(() => decodeOpenResult(enc({ format: 1, doc: { type: 'doc', content: [{ type: 'text', text: 'bare' }] } }))).toThrow();
    expect(() => decodeOpenResult(new Uint8Array([1, 2, 3]))).toThrow();
  });

  it('hashes like Node’s sha256 (the background pre-converter keys with that)', async () => {
    const bytes = await sampleDocx();
    expect(await sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'));
  });
});
