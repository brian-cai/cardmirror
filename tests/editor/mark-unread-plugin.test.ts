import { describe, it, expect } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { READING_MARKER_COLOR, READING_MARKER_ROLE } from '../../src/editor/reading-marker.js';
import { computeUnreadDecorations } from '../../src/editor/mark-unread-plugin.js';
import type { Node as PMNode } from 'prosemirror-model';

function tag(text: string) {
  return schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text));
}
function cardBody(...inline: PMNode[]) {
  return schema.nodes['card_body']!.create(null, inline);
}
function marker() {
  return schema.text('Marked 7:32', [
    schema.marks['font_color']!.create({ color: READING_MARKER_COLOR, role: READING_MARKER_ROLE }),
  ]);
}
/** Red text that is NOT a marker (hand-colored body, baked unread red, a
 *  Verbatim file's own red) — must never start the tint. */
function plainRed(text: string) {
  return schema.text(text, [schema.marks['font_color']!.create({ color: READING_MARKER_COLOR })]);
}
function markerNode() {
  return schema.nodes['reading_marker']!.create({ time: '7:32' });
}
function card(...c: PMNode[]) { return schema.nodes['card']!.createChecked(null, c); }
function makeDoc(...c: PMNode[]) { return schema.nodes['doc']!.createChecked(null, c); }

/** The text each decoration covers, in doc order: the observable behavior. */
function decoratedText(doc: PMNode): string[] {
  return computeUnreadDecorations(doc)
    .sort((a, b) => a.from - b.from)
    .map((d) => doc.textBetween(d.from, d.to));
}

describe('computeUnreadDecorations', () => {
  it('reddens body text after the marker, across paragraphs, within the card', () => {
    const doc = makeDoc(
      card(
        tag('nuclear war causes extinction'),
        cardBody(schema.text('sentence 1. '), marker(), schema.text(' ')),
        cardBody(schema.text('sentence 2.')),
        cardBody(schema.text('sentence 3.')),
      ),
    );
    // "sentence 1." (before the marker) stays; the trailing run of the
    // marker's paragraph and both following paragraphs go red.
    expect(decoratedText(doc)).toEqual([' ', 'sentence 2.', 'sentence 3.']);
  });

  it('does nothing to a card with no marker', () => {
    const doc = makeDoc(card(tag('T'), cardBody(schema.text('unread but unmarked'))));
    expect(computeUnreadDecorations(doc)).toEqual([]);
  });

  it('is bounded per card: a marker in one card never reddens the next', () => {
    const doc = makeDoc(
      card(tag('A'), cardBody(schema.text('a1. '), marker()), cardBody(schema.text('a2.'))),
      card(tag('B'), cardBody(schema.text('b1.')), cardBody(schema.text('b2.'))),
    );
    expect(decoratedText(doc)).toEqual(['a2.']);
  });

  it('leaves the tag and text before the marker uncolored', () => {
    const doc = makeDoc(
      card(tag('TAG'), cardBody(schema.text('before '), marker(), schema.text(' after'))),
    );
    expect(decoratedText(doc)).toEqual([' after']);
  });
});

describe('markUnreadPlugin incremental updates', () => {
  const key = (doc: PMNode, decos: readonly { from: number; to: number }[]) =>
    decos
      .map((d) => `${d.from}-${d.to}:${doc.textBetween(d.from, d.to)}`)
      .sort();

  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function textPositions(doc: PMNode): number[] {
    const out: number[] = [];
    doc.descendants((node, pos) => {
      if (node.isTextblock) for (let k = 0; k <= node.content.size; k++) out.push(pos + 1 + k);
      return !node.isTextblock;
    });
    return out;
  }

  function randomDoc(rand: () => number): PMNode {
    const cards: PMNode[] = [];
    const n = 3 + Math.floor(rand() * 5);
    for (let i = 0; i < n; i++) {
      const bodies: PMNode[] = [];
      const m = 1 + Math.floor(rand() * 3);
      for (let j = 0; j < m; j++) {
        bodies.push(rand() < 0.3 ? cardBody(schema.text(`b${i}${j} `), marker(), schema.text(' rest')) : cardBody(schema.text(`body ${i}.${j}`)));
      }
      cards.push(card(tag(`Tag ${i}`), ...bodies));
    }
    return makeDoc(...cards);
  }

  it('matches a full rebuild after random edits (typing, markers, deletes, splits)', async () => {
    const { EditorState } = await import('prosemirror-state');
    const { settings } = await import('../../src/editor/settings.js');
    const { markUnreadPlugin } = await import('../../src/editor/mark-unread-plugin.js');
    const was = settings.get('markUnreadAfterMarker');
    settings.set('markUnreadAfterMarker', true);
    try {
      for (let seed = 1; seed <= 150; seed++) {
        const rand = rng(seed);
        let state = EditorState.create({ doc: randomDoc(rand), plugins: [markUnreadPlugin] });
        for (let k = 0; k < 25; k++) {
          const spots = textPositions(state.doc);
          const a = spots[Math.floor(rand() * spots.length)]!;
          const b = spots[Math.floor(rand() * spots.length)]!;
          const tr = state.tr;
          const op = Math.floor(rand() * 6);
          try {
            if (op === 0) tr.insertText('x', a);
            else if (op === 1) tr.insert(a, marker());
            else if (op === 2) tr.delete(Math.min(a, b), Math.max(a, b));
            else if (op === 3) tr.removeMark(Math.min(a, b), Math.max(a, b), schema.marks['font_color']!);
            else if (op === 4) tr.split(a);
            else tr.insertText('ab', a).delete(a, a + 1);
          } catch {
            continue; // an edit the schema refuses
          }
          if (!tr.docChanged) continue;
          state = state.apply(tr);
          const live = markUnreadPlugin.getState(state)!.set.find();
          expect(key(state.doc, live), `seed ${seed} step ${k}`).toEqual(key(state.doc, computeUnreadDecorations(state.doc)));
        }
      }
    } finally {
      settings.set('markUnreadAfterMarker', was);
    }
  });
});

describe('computeUnreadDecorations — what is NOT a marker', () => {
  it('plain red text never starts the tint (hand-colored, baked unread red, Verbatim red)', () => {
    const doc = makeDoc(card(tag('T'), cardBody(plainRed('Marked 7:32 and all of this is red.'), schema.text(' tail'))));
    expect(decoratedText(doc)).toEqual([]);
  });

  it('the dormant reading_marker node is a marker', () => {
    const doc = makeDoc(card(tag('T'), cardBody(schema.text('before '), markerNode(), schema.text(' after'))));
    expect(decoratedText(doc)).toEqual([' after']);
  });
});
