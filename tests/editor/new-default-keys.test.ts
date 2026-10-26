// @vitest-environment jsdom
/**
 * New default keys (1.15.46: Send to Starred on Mod-Shift-P): on the first
 * run with the default, a user override that already uses the key keeps
 * it and the new default yields; without a clash nothing changes; it runs
 * once.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRibbonKeymap, migrateNewDefaultKeys } from '../../src/editor/ribbon-commands.js';
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
