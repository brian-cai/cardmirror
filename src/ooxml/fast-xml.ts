/**
 * A small, fast XML parser for OOXML parts, producing EXACTLY the
 * order-preserving shape `fast-xml-parser` gives with the options in
 * parse.ts (`preserveOrder`, attributes under ':@', no value parsing, no
 * trimming) — a drop-in replacement for `parseXml`, verified output-equal
 * against fast-xml-parser on fixtures and real debate files
 * (tests/ooxml/fast-xml.test.ts).
 *
 * Why: parsing `word/document.xml` was two thirds of opening a large .docx
 * (35 MB of XML: 4.8 s of a 7.5 s open). OOXML is plain, regular XML — no
 * DTDs, no custom entities — so a single forward scan with `indexOf` does
 * the job in a fraction of the time.
 *
 * Matches fast-xml-parser's behavior, including its quirks:
 *   - only the five predefined entities are decoded (&amp; &lt; &gt; &quot;
 *     &apos;), in ONE pass (so `&amp;lt;` → `&lt;`); numeric references like
 *     `&#169;` and unknown entities are left as written;
 *   - CDATA content is kept raw (no entity decoding);
 *   - comments and DOCTYPE are dropped;
 *   - a processing instruction becomes `{ '?name': [{ '#text': '' }], ':@': attrs }`;
 *   - line endings are normalized (\r\n and lone \r become \n), as the XML
 *     spec requires;
 *   - whitespace-only text between tags is kept;
 *   - ':@' appears only when the element has attributes.
 */
import type { XmlNode } from './parse.js';

const ENTITY_RE = /&(amp|lt|gt|quot|apos);/g;
const ENTITY_MAP: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.indexOf('&') === -1 ? s : s.replace(ENTITY_RE, (_, e: string) => ENTITY_MAP[e]!);
}

function isNameEnd(c: number): boolean {
  // whitespace, '/', '>', '?' (PI), '='
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 47 || c === 62 || c === 63 || c === 61;
}

/** Parse attributes in `xml` between `start` and `end` (exclusive). Returns
 *  null when there are none. */
function parseAttrs(xml: string, start: number, end: number): Record<string, string> | null {
  let out: Record<string, string> | null = null;
  let i = start;
  while (i < end) {
    let c = xml.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 47) {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < end && !isNameEnd(xml.charCodeAt(i))) i++;
    const name = xml.slice(nameStart, i);
    while (i < end && (xml.charCodeAt(i) === 32 || xml.charCodeAt(i) === 9 || xml.charCodeAt(i) === 10 || xml.charCodeAt(i) === 13)) i++;
    if (xml.charCodeAt(i) !== 61 /* = */) {
      // Value-less attribute: not valid XML and absent from OOXML; skip it.
      if (i === nameStart) i++;
      continue;
    }
    i++;
    while (i < end && (xml.charCodeAt(i) === 32 || xml.charCodeAt(i) === 9 || xml.charCodeAt(i) === 10 || xml.charCodeAt(i) === 13)) i++;
    c = xml.charCodeAt(i);
    if (c !== 34 && c !== 39) continue; // unquoted: not XML
    const close = xml.indexOf(c === 34 ? '"' : "'", i + 1);
    if (close === -1 || close > end) break;
    (out ??= {})[name] = decode(xml.slice(i + 1, close));
    i = close + 1;
  }
  return out;
}

/** End of a start tag beginning at `i` ('<'), skipping '>' inside quoted
 *  attribute values. */
function tagEnd(xml: string, i: number): number {
  let quote = 0;
  for (let j = i + 1; j < xml.length; j++) {
    const c = xml.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return j;
    }
  }
  return -1;
}

export function parseXmlFast(input: string): XmlNode[] {
  const xml = input.indexOf('\r') === -1 ? input : input.replace(/\r\n?/g, '\n');
  const root: XmlNode[] = [];
  const stack: XmlNode[][] = [root];
  let top = root;
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      // Text outside any element (e.g. the newline after the XML
      // declaration) is dropped, as fast-xml-parser does.
      if (stack.length > 1) top.push({ '#text': decode(xml.slice(i, textEnd)) } as XmlNode);
    }
    if (lt === -1) break;
    const next = xml.charCodeAt(lt + 1);
    if (next === 47 /* </ */) {
      const close = xml.indexOf('>', lt + 2);
      if (stack.length > 1) {
        stack.pop();
        top = stack[stack.length - 1]!;
      }
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (next === 33 /* <! */) {
      if (xml.startsWith('<!--', lt)) {
        const close = xml.indexOf('-->', lt + 4);
        i = close === -1 ? n : close + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const close = xml.indexOf(']]>', lt + 9);
        const end = close === -1 ? n : close;
        top.push({ '#text': xml.slice(lt + 9, end) } as XmlNode);
        i = close === -1 ? n : close + 3;
      } else {
        // DOCTYPE and other declarations: skip.
        const close = tagEnd(xml, lt);
        i = close === -1 ? n : close + 1;
      }
      continue;
    }
    if (next === 63 /* <? */) {
      const close = xml.indexOf('?>', lt + 2);
      const end = close === -1 ? n : close;
      let j = lt + 2;
      while (j < end && !isNameEnd(xml.charCodeAt(j))) j++;
      const name = '?' + xml.slice(lt + 2, j);
      const node = { [name]: [{ '#text': '' }] } as unknown as XmlNode;
      const attrs = parseAttrs(xml, j, end);
      if (attrs) node[':@'] = attrs;
      top.push(node);
      i = close === -1 ? n : close + 2;
      continue;
    }
    const end = tagEnd(xml, lt);
    if (end === -1) break;
    const selfClosing = xml.charCodeAt(end - 1) === 47;
    let j = lt + 1;
    while (j < end && !isNameEnd(xml.charCodeAt(j))) j++;
    const name = xml.slice(lt + 1, j);
    const children: XmlNode[] = [];
    const node = { [name]: children } as unknown as XmlNode;
    const attrs = parseAttrs(xml, j, selfClosing ? end - 1 : end);
    if (attrs) node[':@'] = attrs;
    top.push(node);
    if (!selfClosing) {
      stack.push(children);
      top = children;
    }
    i = end + 1;
  }
  return root;
}
