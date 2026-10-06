/**
 * Ribbon button size: stored values snap to the offered sizes, junk
 * falls back to normal, and the row lives under Appearance.
 */
import { describe, it, expect } from 'vitest';
import { RIBBON_SCALES, sanitizeRibbonScale, SETTING_METADATA, settings } from '../../src/editor/settings.js';

describe('ribbon button size setting', () => {
  it('defaults to normal', () => {
    expect(settings.get('ribbonScale')).toBe(100);
  });
  it('keeps offered sizes and snaps everything else to the nearest one', () => {
    for (const n of RIBBON_SCALES) expect(sanitizeRibbonScale(n)).toBe(n);
    expect(sanitizeRibbonScale(120)).toBe(115);
    expect(sanitizeRibbonScale(999)).toBe(150);
    expect(sanitizeRibbonScale(10)).toBe(100);
    expect(sanitizeRibbonScale('big')).toBe(100);
    expect(sanitizeRibbonScale(NaN)).toBe(100);
  });
  it('is an Appearance row', () => {
    const meta = SETTING_METADATA.find((m) => m.key === 'ribbonScale');
    expect(meta?.category).toBe('appearance');
  });
});
