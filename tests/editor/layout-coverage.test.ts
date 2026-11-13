/**
 * Every dialog style is either opened by the layout check (dev/layout-harness,
 * run in CI) or listed as pending with a reason, so a new dialog can't skip
 * the "does it fit the window" check by accident.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COVERED, PENDING } from '../../dev/layout-harness/coverage.js';

const css = readFileSync(new URL('../../src/editor/style.css', import.meta.url), 'utf8');
const harness = readFileSync(new URL('../../dev/layout-harness/harness.ts', import.meta.url), 'utf8');
const dialogClasses = [...new Set([...css.matchAll(/\.(pmd-[a-z0-9-]+-dialog)\b/g)].map((m) => m[1]!))].sort();

describe('layout check coverage', () => {
  it('every dialog class is covered by a scenario or pending with a reason', () => {
    const missing = dialogClasses.filter((c) => !(c in COVERED) && !(c in PENDING));
    expect(missing, 'add a scenario in dev/layout-harness/harness.ts (and coverage.ts COVERED), or a PENDING reason').toEqual([]);
  });

  it('no class is both covered and pending, and none is listed that no longer exists', () => {
    expect(Object.keys(COVERED).filter((c) => c in PENDING)).toEqual([]);
    const gone = [...Object.keys(COVERED), ...Object.keys(PENDING)].filter((c) => !dialogClasses.includes(c));
    expect(gone).toEqual([]);
  });

  it('every scenario named in COVERED exists in the harness', () => {
    const named = [...new Set(Object.values(COVERED).flat())].filter((s) => !s.startsWith('settings-'));
    expect(named.filter((s) => !harness.includes(`'${s}'`))).toEqual([]);
  });
});
