// @vitest-environment jsdom
/**
 * Clipboard HTML from word processors other than Word → CardMirror
 * (smart paste, 'office' route). Field report 2026-10-14: students
 * without Word opened a team .docx in Google Docs / Pages and every
 * card they copied out pasted with no underlining or highlighting —
 * the default paste path reads only CardMirror's own classes, `<u>`
 * and `<mark>`. Fixtures follow each app's clipboard shape: Docs'
 * inline styles in a docs-internal-guid wrapper, the Cocoa writer's
 * head classes with px-for-pt sizes, LibreOffice's `<u>` + background.
 */
import { describe, expect, it } from 'vitest';
import { type Node as PMNode } from 'prosemirror-model';
import { convertOfficeHtml, convertWordHtml } from '../../src/import/html-paste.js';

function marksAt(doc: PMNode, sub: string): string[] {
  let found: string[] | null = null;
  doc.descendants((n) => {
    if (found) return false;
    if (n.isText && n.text?.includes(sub)) {
      found = n.marks.map((m) => (m.type.name === 'highlight' ? `highlight:${m.attrs['color']}` : m.type.name)).sort();
      return false;
    }
    return true;
  });
  return found ?? [];
}

function blockTypes(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n) => {
    if (n.isTextblock) {
      out.push(n.type.name);
      return false;
    }
    return true;
  });
  return out;
}

const U = 'text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;';

const DOCS_CARD = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d-7fff-1234-5678"><h4 dir="ltr" style="line-height:1.08;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:13pt;font-family:Calibri,sans-serif;font-weight:700;">Warming causes extinction</span></h4><p dir="ltr" style="line-height:1.08;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:13pt;font-family:Calibri,sans-serif;font-weight:700;">Smith 24</span><span style="font-size:11pt;font-family:Calibri,sans-serif;font-weight:400;">, Professor at Harvard</span></p><p dir="ltr" style="line-height:1.08;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Calibri,sans-serif;font-weight:400;">Lead in </span><span style="font-size:11pt;font-family:Calibri,sans-serif;font-weight:400;${U}">the climate is</span><span style="font-size:11pt;font-family:Calibri,sans-serif;font-weight:400;"> </span><span style="font-size:11pt;font-family:Calibri,sans-serif;background-color:#00ffff;font-weight:400;${U}">warming rapidly</span><span style="font-size:11pt;font-family:Calibri,sans-serif;font-weight:400;"> and </span><span style="font-size:11pt;font-family:Calibri,sans-serif;background-color:#00ffff;font-weight:700;${U}">extinction</span></p></b>`;

describe('convertOfficeHtml', () => {
  it('Google Docs card: tag, cite, underline and highlight survive', () => {
    const doc = convertOfficeHtml(DOCS_CARD)!;
    expect(doc).not.toBeNull();
    expect(blockTypes(doc)).toEqual(['tag', 'cite_paragraph', 'card_body']);
    expect(marksAt(doc, 'the climate is')).toEqual(['underline_mark']);
    expect(marksAt(doc, 'warming rapidly')).toEqual(['highlight:cyan', 'underline_mark']);
    expect(marksAt(doc, 'Smith 24')).toEqual(['cite_mark']);
  });

  it('Google Docs mid-line copy (bare spans, no <p>) keeps its formatting', () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-9"><span style="font-size:11pt;${U}">the climate is</span><span style="font-size:11pt;"> </span><span style="font-size:11pt;background-color:#ffff00;${U}">warming</span></b>`;
    const doc = convertOfficeHtml(html)!;
    expect(doc).not.toBeNull();
    expect(marksAt(doc, 'the climate is')).toEqual(['underline_mark']);
    expect(marksAt(doc, 'warming')).toEqual(['highlight:yellow', 'underline_mark']);
  });

  it('Pages / TextEdit (Cocoa writer): class CSS, px sizes read as points', () => {
    const html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="Generator" content="Cocoa HTML Writer"><style type="text/css">
    p.p1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 11.0px Calibri}
    span.s1 {font: 13.0px Calibri}
    span.s2 {text-decoration: underline}
    span.s3 {text-decoration: underline; background-color: #ffff00}
  </style></head><body><p class="p1"><span class="s1"><b>Smith 24</b></span>, Professor</p><p class="p1">Lead in <span class="s2">the climate is</span> <span class="s3">warming rapidly</span> soon.</p></body></html>`;
    const doc = convertOfficeHtml(html)!;
    expect(doc).not.toBeNull();
    expect(marksAt(doc, 'Smith 24')).toEqual(['cite_mark']);
    expect(marksAt(doc, 'the climate is')).toEqual(['underline_mark']);
    expect(marksAt(doc, 'warming rapidly')).toEqual(['highlight:yellow', 'underline_mark']);
  });

  it('LibreOffice: <u> and background highlights', () => {
    const html = `<html><head><meta name="generator" content="LibreOffice 24.2.0.3 (MacOSX)"/></head><body><p>Lead in <u>the climate is</u> <u><span style="background: #ffff00">warming</span></u></p></body></html>`;
    const doc = convertOfficeHtml(html)!;
    expect(doc).not.toBeNull();
    expect(marksAt(doc, 'warming')).toEqual(['highlight:yellow', 'underline_mark']);
  });

  it('plain prose with no card formatting falls through (null)', () => {
    const html = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-2"><p dir="ltr"><span style="font-size:11pt;">Meeting notes, nothing cut.</span></p></b>`;
    expect(convertOfficeHtml(html)).toBeNull();
  });
});

describe('convertWordHtml — card fragments without structure', () => {
  it('body text copied from mid-card keeps its named underline and highlight', () => {
    const html = `<html xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><style><!--
span.StyleUnderline {mso-style-name:"Style Underline"; text-decoration:underline;}
--></style></head><body><p class=MsoNormal>Lead in <span class=StyleUnderline style='background:cyan;mso-highlight:cyan'>warming rapidly</span></p></body></html>`;
    const doc = convertWordHtml(html)!;
    expect(doc).not.toBeNull();
    expect(marksAt(doc, 'warming rapidly')).toEqual(['highlight:cyan', 'underline_mark']);
  });
});
