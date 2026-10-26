// @vitest-environment jsdom
/**
 * New default keys (1.15.46: Send to Starred on Mod-Shift-P): on the first
 * run with the default, a user override that already uses the key keeps
 * it and the new default yields; without a clash nothing changes; it runs
 * once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRibbonKeymap,
  DEFAULT_RIBBON_KEYS,
  migrateNewDefaultKeys,
  ribbonCommandForKey,
} from '../../src/editor/ribbon-commands.js';
import { settings } from '../../src/editor/settings.js';

beforeEach(() => {
  localStorage.clear();
  settings.set('ribbonKeyOverrides', {});
});

describe('migrateNewDefaultKeys', () => {
  it('a user override on Mod-Shift-P (any case) keeps it; Send to Starred is left unbound', () => {
    settings.set('ribbonKeyOverrides', { pasteAsText: ['Mod-Shift-P'] });
    migrateNewDefaultKeys();
    const o = settings.get('ribbonKeyOverrides');
    expect(o['sendToStarred']).toBe('');
    expect(o['pasteAsText']).toEqual(['Mod-Shift-P']);
    const km = buildRibbonKeymap(o);
    expect(km['Mod-Shift-P']).toBeDefined();
    expect(km['Mod-Shift-p']).toBeUndefined();
  });

  it('no clash → nothing changes, and Mod-Shift-P sends to starred', () => {
    settings.set('ribbonKeyOverrides', { pasteAsText: 'Mod-Alt-v' });
    migrateNewDefaultKeys();
    expect(settings.get('ribbonKeyOverrides')).toEqual({ pasteAsText: 'Mod-Alt-v' });
    expect(buildRibbonKeymap(settings.get('ribbonKeyOverrides'))['Mod-Shift-p']).toBeDefined();
  });

  it('runs once: a later override is the keybindings editor’s business', () => {
    migrateNewDefaultKeys();
    settings.set('ribbonKeyOverrides', { pasteAsText: 'Mod-Shift-p' });
    migrateNewDefaultKeys();
    expect(settings.get('ribbonKeyOverrides')['sendToStarred']).toBeUndefined();
  });

  it('an override of Send to Starred itself is left alone', () => {
    settings.set('ribbonKeyOverrides', { sendToStarred: 'Mod-Shift-p', pasteAsText: 'Mod-Shift-p' });
    migrateNewDefaultKeys();
    expect(settings.get('ribbonKeyOverrides')['sendToStarred']).toBe('Mod-Shift-p');
  });
});

describe('Word / Verbatim muscle-memory defaults (1.15.50)', () => {
  it('bind Word Count, font size, read mode and the timer keys', () => {
    expect(DEFAULT_RIBBON_KEYS.wordCountSelection).toBe('Mod-Shift-g');
    // jsdom is the web build: the bracket aliases stay with the browser.
    expect(DEFAULT_RIBBON_KEYS.adjustFontSizeUp).toBe('Mod-Shift-.');
    expect(DEFAULT_RIBBON_KEYS.adjustFontSizeDown).toBe('Mod-Shift-,');
    expect(DEFAULT_RIBBON_KEYS.toggleReadMode).toBe('Alt-Shift-r');
    expect(DEFAULT_RIBBON_KEYS.timerStartPause).toBe('Alt-Shift-t');
    expect(DEFAULT_RIBBON_KEYS.timerStartAffPrep).toBe('Alt-Shift-a');
    expect(DEFAULT_RIBBON_KEYS.timerStartNegPrep).toBe('Alt-Shift-n');
    expect(ribbonCommandForKey('Mod-Shift-G')).toBe('wordCountSelection');
    expect(ribbonCommandForKey('Alt-Shift-R')).toBe('toggleReadMode');
    // Settings keeps Mod-, ; font size down is the Shift chord only.
    expect(ribbonCommandForKey('Mod-,')).toBe('openSettings');
  });

  it('a user binding on a new default key keeps it; that command is left unbound', () => {
    settings.set('ribbonKeyOverrides', { applyCite: 'Alt-Shift-T', applyHighlight: 'Mod-Shift-g' });
    migrateNewDefaultKeys();
    const o = settings.get('ribbonKeyOverrides');
    expect(o['timerStartPause']).toBe('');
    expect(o['wordCountSelection']).toBe('');
    expect(o['timerStartAffPrep']).toBeUndefined();
    const km = buildRibbonKeymap(o);
    expect(km['Alt-Shift-T']).toBeDefined();
    expect(km['Alt-Shift-t']).toBeUndefined();
  });

  it('a binding recorded as the shifted character (Mod-Shift->) counts as the same key', () => {
    settings.set('ribbonKeyOverrides', { applyCite: 'Mod-Shift->', applyEmphasis: 'Mod-<' });
    migrateNewDefaultKeys();
    const o = settings.get('ribbonKeyOverrides');
    expect(o['adjustFontSizeUp']).toBe('');
    expect(o['adjustFontSizeDown']).toBe('');
  });
});

describe('Mod-Shift-. reaches its binding through the shifted character', () => {
  it('Ctrl+Shift+. (key ">") and Ctrl+Shift+, (key "<") fire the bindings', async () => {
    const { keydownHandler } = await import('prosemirror-keymap');
    const hits: string[] = [];
    const handler = keydownHandler({
      'Mod-Shift-.': () => (hits.push('up'), true),
      'Mod-Shift-,': () => (hits.push('down'), true),
    });
    const press = (key: string, keyCode: number): void => {
      const ev = new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: true });
      Object.defineProperty(ev, 'keyCode', { value: keyCode });
      handler({} as never, ev);
    };
    press('>', 190);
    press('<', 188);
    expect(hits).toEqual(['up', 'down']);
  });
});
