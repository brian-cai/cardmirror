/**
 * `changedRange` (transaction-utils and decoration-range) carries the
 * running union forward one step map at a time instead of mapping each
 * step through `tr.mapping.slice(i + 1)`. These tests pin it to the old
 * per-step-slice results on random multi-step transactions, and guard
 * the linear cost on a transaction with thousands of steps.
 */
import { describe, expect, it } from 'vitest';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';
import { AddMarkStep, RemoveMarkStep, Mapping, findWrapping, liftTarget } from 'prosemirror-transform';
import { changedRange } from '../../src/editor/transaction-utils.js';
import { changedRange as decorationChangedRange } from '../../src/editor/decoration-range.js';

const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    quote: { group: 'block', content: 'block+' },
    text: { group: 'inline' },
  },
  marks: { em: {}, strong: {} },
});

/** The pre-rewrite transaction-utils `changedRange`, verbatim. */
function oldChangedRange(transactions: readonly Transaction[]): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  const expand = (lo: number, hi: number): void => {
    if (lo < from) from = lo;
    if (hi > to) to = hi;
  };
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    for (let i = 0; i < tr.steps.length; i++) {
      const step = tr.steps[i]!;
      const subMapping = tr.mapping.slice(i + 1);
      step.getMap().forEach((_oldFrom, _oldTo, newFrom, newTo) => {
        expand(subMapping.map(newFrom, -1), subMapping.map(newTo, 1));
      });
      if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
        expand(subMapping.map(step.from, -1), subMapping.map(step.to, 1));
      }
    }
  }
  if (from === Infinity) return null;
  return { from, to };
}

/** The pre-rewrite decoration-range `changedRange`, verbatim. */
function oldDecorationChangedRange(tr: Transaction): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  tr.mapping.maps.forEach((map) => {
    map.forEach((_oldFrom, _oldTo, nFrom, nTo) => {
      if (nFrom < from) from = nFrom;
      if (nTo > to) to = nTo;
    });
  });
  tr.steps.forEach((step, i) => {
    const s = step as unknown as { from?: unknown; to?: unknown };
    if (typeof s.from !== 'number' || typeof s.to !== 'number') return;
    const after = tr.mapping.slice(i + 1);
    const f = after.map(s.from, -1);
    const t = after.map(s.to, 1);
    if (f < from) from = f;
    if (t > to) to = t;
  });
  if (from > to) return null;
  return { from, to };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDoc(rand: () => number): PMNode {
  const paras: PMNode[] = [];
  const n = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < n; i++) {
    const len = Math.floor(rand() * 12);
    const text = 'abcdefghijklmnop'.slice(0, len);
    const p = testSchema.nodes['paragraph']!.create(null, len ? testSchema.text(text) : null);
    paras.push(rand() < 0.25 ? testSchema.nodes['quote']!.create(null, p) : p);
  }
  return testSchema.nodes['doc']!.create(null, paras);
}

/** Random position inside some textblock of `doc`. */
function textPos(doc: PMNode, rand: () => number): number {
  const spots: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) for (let k = 0; k <= node.content.size; k++) spots.push(pos + 1 + k);
    return !node.isTextblock;
  });
  return spots[Math.floor(rand() * spots.length)]!;
}

/** Apply one random step (or step group) to `tr`. */
function randomStep(tr: Transaction, rand: () => number): void {
  const doc = tr.doc;
  const a = textPos(doc, rand);
  const b = textPos(doc, rand);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const mark = testSchema.marks[rand() < 0.5 ? 'em' : 'strong']!.create();
  const kind = Math.floor(rand() * 8);
  try {
    switch (kind) {
      case 0:
        tr.insertText('xyz'.slice(0, 1 + Math.floor(rand() * 3)), a);
        break;
      case 1:
        if (hi > lo) tr.delete(lo, hi);
        break;
      case 2:
        tr.replaceWith(lo, hi, testSchema.text('R'));
        break;
      case 3:
        if (hi > lo) tr.addMark(lo, hi, mark);
        break;
      case 4:
        if (hi > lo) tr.removeMark(lo, hi, mark);
        break;
      case 5:
        tr.split(a);
        break;
      case 6: {
        const range = doc.resolve(lo).blockRange(doc.resolve(hi));
        const wrap = range && findWrapping(range, testSchema.nodes['quote']!);
        if (range && wrap) tr.wrap(range, wrap);
        break;
      }
      default: {
        const range = doc.resolve(lo).blockRange(doc.resolve(hi));
        const target = range && liftTarget(range);
        if (range && target != null) tr.lift(range, target);
      }
    }
  } catch {
    // An invalid random edit (e.g. a split at a spot the schema
    // refuses) — skip it; the transaction keeps its earlier steps.
  }
}

describe('changedRange: forward pass matches the per-step-slice version', () => {
  it('random multi-step transactions (insert/delete/replace/mark/split/wrap/lift)', () => {
    let compared = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const rand = rng(seed);
      const state = EditorState.create({ doc: randomDoc(rand) });
      const trs: Transaction[] = [];
      let cur = state;
      const nTrs = 1 + Math.floor(rand() * 3);
      for (let t = 0; t < nTrs; t++) {
        const tr = cur.tr;
        const nSteps = Math.floor(rand() * 14);
        for (let k = 0; k < nSteps; k++) randomStep(tr, rand);
        trs.push(tr);
        cur = cur.apply(tr);
      }
      expect(changedRange(trs), `seed ${seed}`).toEqual(oldChangedRange(trs));
      for (const tr of trs) {
        expect(decorationChangedRange(tr), `seed ${seed}`).toEqual(oldDecorationChangedRange(tr));
      }
      compared += trs.reduce((n, tr) => n + tr.steps.length, 0);
    }
    expect(compared).toBeGreaterThan(2000);
  });

  it('a mapping with mirror pairs still gives the per-step-slice result', () => {
    const rand = rng(7);
    const state = EditorState.create({ doc: randomDoc(rand) });
    const tr = state.tr;
    for (let k = 0; k < 6; k++) randomStep(tr, rand);
    // Mirrors only appear on rebased mappings; mark the first and last
    // maps as a pair so the fallback path runs.
    (tr.mapping as unknown as { setMirror(n: number, m: number): void }).setMirror(0, tr.mapping.maps.length - 1);
    expect(tr.mapping).toBeInstanceOf(Mapping);
    expect(changedRange([tr])).toEqual(oldChangedRange([tr]));
    expect(decorationChangedRange(tr)).toEqual(oldDecorationChangedRange(tr));
  });

  it('a transaction with no doc change is null', () => {
    const state = EditorState.create({ doc: randomDoc(rng(3)) });
    expect(changedRange([state.tr])).toBeNull();
    expect(decorationChangedRange(state.tr)).toBeNull();
  });
});

describe('changedRange: linear in the step count', () => {
  it('12k mark steps (whole-doc F11 shape) stay well under the quadratic cost', () => {
    const paras: PMNode[] = [];
    for (let i = 0; i < 6000; i++) {
      paras.push(testSchema.nodes['paragraph']!.create(null, testSchema.text('alpha beta gamma')));
    }
    const doc = testSchema.nodes['doc']!.create(null, paras);
    const tr = EditorState.create({ doc }).tr;
    const em = testSchema.marks['em']!.create();
    // One AddMarkStep per paragraph run plus a structural edit in the
    // middle, so later maps are non-empty and every earlier bound is mapped.
    for (let i = 0; i < 6000; i++) {
      const start = i * 18 + 1;
      tr.addMark(start, start + 5, em);
      if (i % 1000 === 500) tr.insertText('!', start);
    }
    tr.removeMark(1, 50, em);
    expect(tr.steps.length).toBeGreaterThan(6000);
    const t0 = performance.now();
    const a = changedRange([tr]);
    const b = decorationChangedRange(tr);
    const ms = performance.now() - t0;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // The old per-step slice took ~300 ms / ~700 ms per call at 12k
    // steps on a fast Mac; the forward pass is a few ms. 150 ms is a
    // generous bound for a loaded CI runner that still fails on O(n²).
    expect(ms).toBeLessThan(150);
  });
});
