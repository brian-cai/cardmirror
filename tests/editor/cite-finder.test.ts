import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { applyCiteCandidates, findUnmarkedCites, matchCiteOpening } from '../../src/editor/cite-finder.js';

const span = (t: string): string | null => {
  const m = matchCiteOpening(t);
  return m ? t.slice(m.start, m.end) : null;
};

describe('cite opening matcher', () => {
  it.each([
    ['Smith 24 — John Smith, Professor of Law', 'Smith 24'],
    ['Smith, 2024, “Title,” Journal', 'Smith, 2024'],
    ["Smith '21 [John, Prof]", "Smith '21"],
    ['Smith and Jones 19 (Ana Smith, ...)', 'Smith and Jones 19'],
    ['Smith & Jones, 2019.', 'Smith & Jones, 2019'],
    ['Smith et al. 22, https://doi.org', 'Smith et al. 22'],
    ['Smith (2024) “Title”', 'Smith (2024)'],
    ['Van der Berg 23, analyst', 'Van der Berg 23'],
    ['  CNN 24 https://cnn.com', 'CNN 24'],
    ["O’Neil 20 — Cathy O’Neil", 'O’Neil 20'],
  ])('%s', (text, want) => {
    expect(span(text)).toBe(want);
  });

  it.each([
    'In 2020 the government passed a law',
    'By 2030 warming will exceed',
    'The 2024 election',
    'Since 2019, emissions',
    'January 2024 saw',
    'nuclear war 24 hours',
    'Smith argues that 24 nations',
    'Smith 2024a is something',
  ])('not a cite: %s', (text) => {
    expect(span(text)).toBeNull();
  });
});

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string, marks: string[] = []) =>
  schema.nodes['card_body']!.create(null, schema.text(t, marks.map((m) => schema.marks[m]!.create())));
const card = (...kids: ReturnType<typeof body>[]) => schema.nodes['card']!.create(null, kids);

describe('finding and applying', () => {
  it('finds only unformatted cards whose first paragraph is a cite, then marks them', () => {
    const doc = schema.nodes['doc']!.create(null, [
      card(tag('Unformatted'), body('Smith 24 — John Smith, Professor'), body('Evidence text here.')),
      card(tag('Already formatted'), schema.nodes['cite_paragraph']!.create(null, [
        schema.text('Jones 23', [schema.marks['cite_mark']!.create()]),
        schema.text(' — Jane Jones'),
      ]), body('Evidence.')),
      card(tag('No cite'), body('In 2020 the government passed a law.')),
      card(tag('Cite second'), body('Evidence first.'), body('Lee 22 — Kim Lee')),
    ]);
    const found = findUnmarkedCites(doc);
    expect(found.map((c) => [c.tag, c.spanText])).toEqual([['Unformatted', 'Smith 24']]);

    const state = EditorState.create({ doc });
    const tr = state.tr;
    expect(applyCiteCandidates(tr, found)).toBe(1);
    const marked: string[] = [];
    tr.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'cite_mark')) marked.push(n.text!);
    });
    expect(marked).toEqual(['Smith 24', 'Jones 23']);
    expect(findUnmarkedCites(tr.doc)).toEqual([]);
  });
});
