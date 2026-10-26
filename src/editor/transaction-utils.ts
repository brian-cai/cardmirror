/**
 * Small helpers shared across plugins that need to scope their work
 * to the regions of the doc that actually moved in the current
 * dispatch. Walking the full doc on every transaction is the
 * dominant per-keystroke cost in large workspaces; restricting to
 * `tr.steps`' mapped ranges keeps editing O(1) regardless of doc
 * size for the common typing case.
 */

import type { Transaction } from 'prosemirror-state';
import { AddMarkStep, RemoveMarkStep, type Mapping } from 'prosemirror-transform';

/**
 * Union of every step's affected range in the new doc, across the
 * given transactions. Returns `null` when none of the transactions
 * changed the doc.
 *
 * For structural steps (ReplaceStep, etc.), the range comes from
 * `Step.getMap().forEach` (which yields `(oldFrom, oldTo, newFrom,
 * newTo)`; we collect the new-side bounds because the walk happens
 * against the post-state doc).
 *
 * For mark steps (AddMarkStep / RemoveMarkStep), `getMap` returns
 * `StepMap.empty` — the step doesn't shift any positions — so
 * `forEach` yields nothing. Callers like `cite-classifier-plugin`
 * and `named-style-normalizer-plugin` care about mark changes
 * (a cite_mark add should promote the containing paragraph to
 * `cite_paragraph`), so we extract the mark step's
 * `from`/`to` directly and contribute those to the union too.
 */
export function changedRange(
  transactions: readonly Transaction[],
): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  for (const tr of transactions) {
    if (!tr.docChanged) continue;
    const r = hasMirrors(tr.mapping) ? trRangeSliced(tr) : trRangeForward(tr);
    if (!r) continue;
    if (r.from < from) from = r.from;
    if (r.to > to) to = r.to;
  }
  if (from === Infinity) return null;
  return { from, to };
}

/**
 * One transaction's range in its own final doc, in a single pass:
 * the running union is carried forward through each step map in turn
 * (O(steps)), instead of mapping every step's range through
 * `tr.mapping.slice(i + 1)` (O(steps²): a whole-doc F11 makes ~12k
 * steps and spent seconds here). `StepMap.map` is monotone for a
 * fixed `assoc`, so mapping the running min/max equals the min/max of
 * the individually mapped bounds — same result as `trRangeSliced`.
 */
function trRangeForward(tr: Transaction): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  const maps = tr.mapping.maps;
  for (let i = 0; i < tr.steps.length; i++) {
    const step = tr.steps[i]!;
    const stepMap = maps[i]!;
    if (from !== Infinity) {
      from = stepMap.map(from, -1);
      to = stepMap.map(to, 1);
    }
    stepMap.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
      if (newFrom < from) from = newFrom;
      if (newTo > to) to = newTo;
    });
    // Mark-only steps have an empty stepMap, so the loop above
    // contributes nothing; surface their explicit from/to (see the
    // JSDoc above for why mark changes must count).
    if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
      if (step.from < from) from = step.from;
      if (step.to > to) to = step.to;
    }
  }
  return from === Infinity ? null : { from, to };
}

/**
 * The per-step form: each step's range mapped through the maps after
 * it. Only used for a mapping that carries mirror pairs (rebased
 * steps), where `Mapping.map` can recover positions through a
 * deleted-then-restored pair and so is not a plain composition of the
 * step maps. Plain transactions never have mirrors.
 */
function trRangeSliced(tr: Transaction): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  const expand = (lo: number, hi: number): void => {
    if (lo < from) from = lo;
    if (hi > to) to = hi;
  };
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
  return from === Infinity ? null : { from, to };
}

/**
 * Whether a mapping carries mirror pairs (`appendMap(map, mirrors)`).
 * `mirror` is internal to prosemirror-transform; reading it is the
 * only way to tell, and an absent field reads as "no mirrors".
 */
export function hasMirrors(mapping: Mapping): boolean {
  const mirror = (mapping as unknown as { mirror?: readonly number[] }).mirror;
  return mirror !== undefined && mirror.length > 0;
}
