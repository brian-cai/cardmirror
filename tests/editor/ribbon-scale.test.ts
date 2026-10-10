/**
 * Ribbon button size: stored values snap to the offered sizes, junk
 * falls back to normal, and the row lives under Appearance.
 */
import { describe, it, expect } from 'vitest';
import { RIBBON_SCALES, sanitizeRibbonScale, SETTING_METADATA, settings } from '../../src/editor/settings.js';

describe('ribbon button size setting', () => {
  it('defaults to Larger', () => {
    expect(settings.get('ribbonScale')).toBe(130);
  });
  it('keeps offered sizes and snaps everything else to the nearest one', () => {
    for (const n of RIBBON_SCALES) expect(sanitizeRibbonScale(n)).toBe(n);
    expect(sanitizeRibbonScale(120)).toBe(115);
    expect(sanitizeRibbonScale(999)).toBe(150);
    expect(sanitizeRibbonScale(10)).toBe(100);
    expect(sanitizeRibbonScale('big')).toBe(130);
    expect(sanitizeRibbonScale(undefined)).toBe(130);
    expect(sanitizeRibbonScale(NaN)).toBe(130);
  });
  it('is an Appearance row', () => {
    const meta = SETTING_METADATA.find((m) => m.key === 'ribbonScale');
    expect(meta?.category).toBe('appearance');
  });
});

describe('nav pane text size setting', () => {
  it('defaults to normal and clamps to 70–200% on a 5% step', async () => {
    const { sanitizeNavTextScale } = await import('../../src/editor/settings.js');
    expect(settings.get('navTextScale')).toBe(100);
    expect(sanitizeNavTextScale(85)).toBe(85);
    expect(sanitizeNavTextScale(137)).toBe(135);
    expect(sanitizeNavTextScale(10)).toBe(70);
    expect(sanitizeNavTextScale(500)).toBe(200);
    expect(sanitizeNavTextScale(null)).toBe(100);
    expect(SETTING_METADATA.find((m) => m.key === 'navTextScale')?.category).toBe('appearance');
  });
});

describe('interface size setting', () => {
  it('is an Appearance row that clamps to 50–300% on a 5% step', async () => {
    const { sanitizeChromeScale } = await import('../../src/editor/settings.js');
    expect(sanitizeChromeScale(112)).toBe(110);
    expect(sanitizeChromeScale(1000)).toBe(300);
    expect(sanitizeChromeScale('x')).toBe(100);
    expect(SETTING_METADATA.find((m) => m.key === 'chromeScalePct')?.category).toBe('appearance');
  });
});

describe('nav text size in place', () => {
  it('steps 5% at a time and resets to 100%', async () => {
    const { stepNavTextScale, resetNavTextScale } = await import('../../src/editor/nav-text-size.js');
    settings.set('navTextScale', 100);
    stepNavTextScale(2);
    expect(settings.get('navTextScale')).toBe(110);
    stepNavTextScale(-100);
    expect(settings.get('navTextScale')).toBe(70);
    resetNavTextScale();
    expect(settings.get('navTextScale')).toBe(100);
  });
});
