/**
 * OS detection for Settings → General → About this install.
 *
 * Regression guard for the Chromebook case: ChromeOS user agents read
 * `X11; CrOS x86_64 …` and contain neither "Linux" nor "Android", so
 * they fell through every branch and reported "Unknown" — on the exact
 * platform the web edition's save-path reports come from.
 */

import { describe, expect, it } from 'vitest';
import { detectOS, versionLabel } from '../../src/editor/install-info.js';

const UA = {
  chromeOS:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  mac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  ipadLegacy:
    'Mozilla/5.0 (iPad; CPU OS 12_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  ipadOS:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Safari/605.1.15',
};

describe('detectOS', () => {
  it('names ChromeOS rather than falling through to Unknown', () => {
    expect(detectOS(UA.chromeOS)).toBe('ChromeOS');
  });

  it('still identifies the other platforms', () => {
    expect(detectOS(UA.mac)).toBe('macOS');
    expect(detectOS(UA.windows)).toBe('Windows');
    expect(detectOS(UA.linux)).toBe('Linux');
    expect(detectOS(UA.android)).toBe('Android');
  });

  it('names iOS despite the agent saying "like Mac OS X"', () => {
    expect(detectOS(UA.iphone)).toBe('iOS');
    expect(detectOS(UA.ipadLegacy)).toBe('iOS');
  });

  it('reports desktop-class iPadOS as macOS — the agent is identical', () => {
    // Not a wish, just the truth: iPadOS Safari sends the Macintosh
    // agent verbatim, so nothing in the string can separate them. Pinned
    // so the limitation is visible rather than mistaken for a bug.
    expect(detectOS(UA.ipadOS)).toBe('macOS');
  });

  it('reports Unknown for an empty or unrecognized agent', () => {
    expect(detectOS('')).toBe('Unknown');
    expect(detectOS('Some/1.0 (unknown platform)')).toBe('Unknown');
  });
});

describe('versionLabel', () => {
  it("names the fork in the Version row, and keeps Lite's own label", () => {
    expect(versionLabel('1.15.60', false)).toBe("1.15.60 (BCai's build)");
    expect(versionLabel('1.15.60', true)).toBe('1.15.60 (CardMirror Lite)');
  });
});
