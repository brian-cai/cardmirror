// @vitest-environment jsdom
//
// Replace is reachable from a plain Find: the chevron at the start of
// the find row shows / hides the replace row in place, and opening in
// replace mode shows it expanded.
import { describe, it, expect, beforeEach } from 'vitest';
import { FindReplaceBar } from '../../src/editor/find-replace-ui.js';
import { DEFAULT_RIBBON_KEYS } from '../../src/editor/ribbon-commands.js';

const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('find bar: replace toggle', () => {
  it('a plain Find shows the chevron collapsed, and clicking it reveals Replace', () => {
    const bar = new FindReplaceBar(() => null);
    bar.open({ mode: 'find', sortMode: 'categorized' });
    const toggle = q<HTMLButtonElement>('.pmd-find-replace-toggle');
    const row = q<HTMLElement>('.pmd-find-replace-row');
    expect(row.hidden).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(row.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.title).toBe('Hide Replace');
    expect(document.activeElement).toBe(q('.pmd-find-replace-input'));

    toggle.click();
    expect(row.hidden).toBe(true);
    expect(document.activeElement).toBe(q('.pmd-find-input'));
  });

  it('opening in replace mode shows it expanded', () => {
    const bar = new FindReplaceBar(() => null);
    bar.open({ mode: 'replace', sortMode: 'categorized' });
    expect(q<HTMLElement>('.pmd-find-replace-row').hidden).toBe(false);
    expect(q('.pmd-find-replace-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('Find and Replace has a default key (Ctrl-H off macOS)', () => {
    // jsdom's navigator.platform is not mac.
    expect(DEFAULT_RIBBON_KEYS.openFindReplace).toBe('Mod-h');
  });
});
