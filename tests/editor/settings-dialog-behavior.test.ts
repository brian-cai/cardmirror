// @vitest-environment jsdom

/**
 * Settings dialog behavior outside the individual controls: deep links,
 * tab keys, rows that come and go with another setting, and the list
 * editors keeping their rows (and so focus) across a field edit.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
// benchmark-ui transitively imports editor/index.ts, whose module body
// wires the real app's DOM at import time — fatal in a bare jsdom.
vi.mock('../../src/editor/benchmark-ui.js', () => ({ launchBenchmarkOverlay: vi.fn() }));
const host = vi.hoisted(
  () =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'kind') return 'electron';
          return () => Promise.resolve({});
        },
      },
    ),
);
vi.mock('../../src/editor/host/index.js', () => ({
  getElectronHost: () => host,
  getHost: () => host,
  isWindowsHost: () => false,
}));

import { openSettings, closeSettings } from '../../src/editor/settings-ui.js';
import { settings } from '../../src/editor/settings.js';
import { showToast } from '../../src/editor/toast.js';

// jsdom lacks ResizeObserver (the modal's tab-strip arrows use one).
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;
// jsdom has no layout, so no scrollIntoView.
Element.prototype.scrollIntoView ??= () => {};
// …and no CSS.escape (the deep link builds a selector with it).
(globalThis as { CSS?: unknown }).CSS ??= { escape: (v: string) => v };

afterEach(() => {
  closeSettings();
  settings.set('timerSoundEnabled', false);
  settings.set('pairingPartners', []);
  settings.set('pairingGroups', []);
  settings.set('pairingStarred', null);
});

const activeTab = (): string | null | undefined =>
  document.querySelector('.pmd-settings-tab-active')?.textContent;
const row = (key: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-setting-key="${key}"]`);
  if (!el) throw new Error(`no row: ${key}`);
  return el;
};
function commit(el: HTMLInputElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('settings dialog', () => {
  it('a link to a setting opens that setting’s tab', () => {
    openSettings({ category: 'general' });
    closeSettings();
    openSettings({ settingKey: 'navTextScale' });
    expect(activeTab()).toBe('Appearance');
  });

  it('arrow keys move between tabs', () => {
    openSettings({ category: 'general' });
    const strip = document.querySelector('.pmd-settings-tabs')!;
    const first = activeTab();
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(activeTab()).not.toBe(first);
    expect(document.activeElement).toBe(document.querySelector('.pmd-settings-tab-active'));
    strip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(activeTab()).toBe(first);
  });

  it('a row that depends on another setting appears and goes as it changes', () => {
    openSettings();
    expect(row('timerSoundVolume').style.display).toBe('none');
    settings.set('timerSoundEnabled', true);
    expect(row('timerSoundVolume').style.display).toBe('');
    settings.set('timerSoundEnabled', false);
    expect(row('timerSoundVolume').style.display).toBe('none');
  });

  it('a greyed row says which setting to turn on', () => {
    settings.set('aiFeaturesEnabled', false);
    openSettings();
    expect(row('aiProvider').title).toContain('Enable AI features');
    settings.set('aiFeaturesEnabled', true);
    expect(row('aiProvider').title).toBe('');
    settings.set('aiFeaturesEnabled', false);
  });

  it('opening again while open keeps what is typed in the search box', () => {
    openSettings();
    const search = document.querySelector<HTMLInputElement>('.pmd-settings-search')!;
    search.value = 'zoom';
    openSettings();
    expect(document.querySelector<HTMLInputElement>('.pmd-settings-search')).toBe(search);
    expect(search.value).toBe('zoom');
  });
});

describe('list editors', () => {
  it('a font size edit keeps the rows and stores half points', () => {
    openSettings();
    const inputs = document.querySelectorAll<HTMLInputElement>('.pmd-display-size-input');
    const first = inputs[0]!;
    const before = first.value;
    commit(first, '13.3');
    expect(first.isConnected).toBe(true);
    expect(inputs[1]!.isConnected).toBe(true);
    expect(first.value).toBe('13.5');
    commit(first, before);
  });

  it('replacing a recipient’s code keeps their groups and star', () => {
    settings.set('pairingEnabled', true);
    settings.set('pairingPartners', [{ code: '', name: 'Ann' }, { code: '', name: 'Bo' }]);
    openSettings({ category: 'pairing' });
    const codeInputs = (): HTMLInputElement[] =>
      [...document.querySelectorAll<HTMLInputElement>('.pmd-pairing-row .pmd-pairing-code')];
    commit(codeInputs()[0]!, 'cmk1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const a = settings.get('pairingPartners')[0]!.code;
    expect(a).not.toBe('');
    settings.set('pairingGroups', [{ id: 'g1', label: 'Team', memberCodes: [a] }]);
    settings.set('pairingStarred', { kind: 'partner', ref: a });

    const input = codeInputs()[0]!;
    commit(input, 'cmk1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
    const b = settings.get('pairingPartners')[0]!.code;
    expect(b).not.toBe(a);
    expect(settings.get('pairingGroups')[0]!.memberCodes).toEqual([b]);
    expect(settings.get('pairingStarred')).toEqual({ kind: 'partner', ref: b });

    // The same code on a second row is refused.
    const second = codeInputs()[1]!;
    commit(second, b);
    expect(settings.get('pairingPartners')[1]!.code).toBe('');
    expect(second.value).toBe('');
    expect(showToast).toHaveBeenCalled();
  });

  it('a group keeps its name when the field is cleared', () => {
    settings.set('pairingEnabled', true);
    settings.set('pairingGroups', [{ id: 'g1', label: 'Team', memberCodes: [] }]);
    openSettings({ category: 'pairing' });
    const label = document.querySelector<HTMLInputElement>('.pmd-pairing-group .pmd-pairing-name')!;
    commit(label, '   ');
    expect(settings.get('pairingGroups')[0]!.label).toBe('Team');
    expect(label.value).toBe('Team');
  });
});
