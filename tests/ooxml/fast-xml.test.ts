// @vitest-environment node
/**
 * parseXmlFast must produce exactly what fast-xml-parser (with the
 * parse.ts options) produces — it replaces it on the .docx open path.
 * Beyond these cases it was checked output-equal on 4,035 XML parts
 * (437 MB) of real debate files.
 */
import { describe, expect, it } from 'vitest';
import { parseXmlFast } from '../../src/ooxml/fast-xml.js';
import { parseXmlReference } from '../../src/ooxml/parse.js';

const same = (xml: string): void => {
  expect(JSON.stringify(parseXmlFast(xml))).toBe(JSON.stringify(parseXmlReference(xml)));
};

describe('parseXmlFast', () => {
  it.each([
    ['declaration + root', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document xmlns:w="x"><w:body/></w:document>'],
    ['whitespace text kept', '<a>\n  <b c="1"/>\n</a>'],
    ['five entities, one pass; numeric refs left alone', '<w:t xml:space="preserve"> A &amp; B &lt;C&gt; &#169; &#x263A; &apos;x&apos; &amp;lt; </w:t>'],
    ['entities in attributes', '<a b="1 &amp; 2 &quot;q&quot; &amp;lt;" c="x&#10;y"/>'],
    ['comments dropped, CDATA raw', '<a><!-- c --><b/><![CDATA[raw <stuff> &amp;]]></a>'],
    ['empty and self-closing', '<a></a><b/><c d=""/>'],
    ['mixed text and elements', "<a x='single'>t1<b/>t2</a>"],
    ['unknown entity left', '<a>&unknown; &gt y</a>'],
    ['> inside an attribute', '<a b="x > y">t</a>'],
    ['spacing around =', '<a b="1"   c = "2"/>'],
    ['CRLF normalized in text and attributes', '<a b="1\r\n2">l1\r\nl2\rl3</a>'],
    ['tabs and lone spaces', '<a>\t</a><b> </b>'],
  ])('%s', (_label, xml) => same(xml));

  it('matches on a large generated document.xml', () => {
    const paras: string[] = [];
    for (let i = 0; i < 400; i++) {
      paras.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading${(i % 4) + 1}"/></w:pPr>` +
          `<w:r><w:rPr><w:b/><w:highlight w:val="cyan"/></w:rPr><w:t xml:space="preserve">Card ${i} &amp; &lt;tag&gt; </w:t></w:r>` +
          `<w:r><w:t>“quoted” — ${'x'.repeat(i % 50)}</w:t></w:r></w:p>\r\n`,
      );
    }
    same(`<?xml version="1.0"?>\r\n<w:document xmlns:w="w"><w:body>${paras.join('')}<w:sectPr/></w:body></w:document>`);
  });
});
