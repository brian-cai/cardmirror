/**
 * Find cites nobody formatted. Read mode shows a card's "Author Year" only
 * when it carries the cite mark (F8); teams that paste cites as plain text
 * lose who wrote the card in read mode. This finds cards with no cite
 * formatting at all whose first paragraph opens like a cite ("Smith 24",
 * "Smith and Jones, 2019", "Smith et al. '21", "Smith (2024)") and
 * proposes the span to mark. The caller reviews and applies.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';

export interface CiteCandidate {
  /** Position of the paragraph holding the cite. */
  paraPos: number;
  /** Document range to mark. */
  from: number;
  to: number;
  /** The card's tag text, for the review list. */
  tag: string;
  /** The whole paragraph's text. */
  paraText: string;
  /** Offset of the span within `paraText`. */
  spanStart: number;
  spanText: string;
}

/** Words that open evidence sentences and look like a capitalized name
 *  before a year ("In 2020 …", "By 2030 …"). */
const NOT_AUTHORS = new Set(
  (
    'a an the in on at by of for from to as and or but if so since until after before during ' +
    'between over under around about through this that these those it its we our they ' +
    'their he she his her i you your last next every each early late mid spring summer ' +
    'fall autumn winter january february march april may june july august september october ' +
    'november december jan feb mar apr jun jul aug sep sept oct nov dec fy q1 q2 q3 q4 ' +
    'figure fig table chart page vol no section chapter year years'
  ).split(' '),
);

const NAME = String.raw`(?:[\p{Lu}][\p{L}\p{M}'’.\-]*|(?:van|von|de|del|der|den|da|di|du|le|la|al|el|bin|ibn)(?=\s))`;
const AUTHORS = String.raw`${NAME}(?:\s+${NAME}){0,3}(?:\s*,?\s*(?:and|&)\s+${NAME}(?:\s+${NAME}){0,2}|\s+et\.?\s+al\.?)?`;
const YEAR = String.raw`(?:(?:19|20)\d{2}|['’]?\d{2})`;
/** Author(s), then the year (optionally in parentheses), at the start of
 *  the paragraph, followed by something that isn't more digits or letters. */
const CITE_OPENING = new RegExp(
  String.raw`^(\s*)(${AUTHORS})([\s,]*\(?\s*)(${YEAR})(\)?)(?=$|[\s,.;:\]\-–—(\[])`,
  'u',
);

/** The cite span at the start of `text`, or null. Exported for tests. */
export function matchCiteOpening(text: string): { start: number; end: number } | null {
  const m = CITE_OPENING.exec(text);
  if (!m) return null;
  const [, lead, authors] = m;
  const firstWord = authors!.split(/[\s,]+/)[0]!.replace(/[.'’]+$/, '').toLowerCase();
  if (NOT_AUTHORS.has(firstWord)) return null;
  return { start: lead!.length, end: m[0].length };
}

const hasCiteMark = (node: PMNode): boolean => {
  let found = false;
  node.descendants((n) => {
    if (found) return false;
    if (n.isText && n.marks.some((m) => m.type.name === 'cite_mark')) found = true;
    return !found;
  });
  return found;
};

/** Every card with no cite formatting whose first paragraph opens like a cite. */
export function findUnmarkedCites(doc: PMNode): CiteCandidate[] {
  const out: CiteCandidate[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'transclusion_ref') return false;
    if (node.type.name !== 'card') return true;
    if (hasCiteMark(node)) return false;
    let tag = '';
    let offset = pos + 1;
    let checked = false;
    node.forEach((child) => {
      const childPos = offset;
      offset += child.nodeSize;
      if (checked) return;
      const name = child.type.name;
      if (name === 'tag') {
        tag = child.textContent.trim();
        return;
      }
      if (name === 'undertag') return;
      const text = child.textContent;
      if (!text.trim()) return;
      // Only the first real paragraph: evidence further down never counts.
      checked = true;
      if (name !== 'card_body' && name !== 'cite_paragraph') return;
      const hit = matchCiteOpening(text);
      if (!hit) return;
      // Text offsets → document positions (inline leaves count as one
      // position but no text, so walk the children).
      const from = textOffsetToPos(child, childPos, hit.start);
      const to = textOffsetToPos(child, childPos, hit.end);
      if (from == null || to == null || to <= from) return;
      out.push({
        paraPos: childPos,
        from,
        to,
        tag,
        paraText: text,
        spanStart: hit.start,
        spanText: text.slice(hit.start, hit.end),
      });
    });
    return false;
  });
  return out;
}

function textOffsetToPos(para: PMNode, paraPos: number, textOffset: number): number | null {
  let seen = 0;
  let pos = paraPos + 1;
  let result: number | null = null;
  para.forEach((child) => {
    if (result != null) return;
    const len = child.isText ? child.text!.length : 0;
    if (child.isText && textOffset <= seen + len) {
      result = pos + (textOffset - seen);
      return;
    }
    seen += len;
    pos += child.nodeSize;
  });
  return result ?? (textOffset === seen ? pos : null);
}

/** Add the cite mark to each candidate whose span still reads the same.
 *  Returns how many were applied. */
export function applyCiteCandidates(tr: Transaction, picked: readonly CiteCandidate[]): number {
  const citeMark = tr.doc.type.schema.marks['cite_mark'];
  if (!citeMark) return 0;
  let n = 0;
  for (const c of picked) {
    if (c.to > tr.doc.content.size) continue;
    if (tr.doc.textBetween(c.from, c.to) !== c.spanText) continue;
    tr.addMark(c.from, c.to, citeMark.create());
    n++;
  }
  return n;
}
