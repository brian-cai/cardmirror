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
    expect(docXml(await toDocx(schema.nodeFromJSON(doc.toJSON()), { defaultFont: 'Calibri' }))).toBe(direct);
  });
});
