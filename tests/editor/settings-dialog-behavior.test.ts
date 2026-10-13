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

import { openSettings, closeSettings, buildEarlierVersionsRow } from '../../src/editor/settings-ui.js';
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

describe('list editors', () => {
  const press = (el: Element | null | undefined): void => {
    (el as HTMLElement).focus();
    (el as HTMLElement).click();
  };

  it('a reorder arrow keeps focus on the item it moved', () => {
    openSettings();
    const arrows = (title: string): HTMLButtonElement[] => [
      ...row('findCategoryOrder').querySelectorAll<HTMLButtonElement>(`button[title="${title}"]`),
    ];
    const before = settings.get('findCategoryOrder').slice();
    press(arrows('Move down')[0]);
    expect(settings.get('findCategoryOrder')[1]).toBe(before[0]);
    expect(document.activeElement).toBe(arrows('Move down')[1]);
    // At the top the up arrow is disabled, so focus goes to the other one.
    press(arrows('Move up')[1]);
    expect(document.activeElement).toBe(arrows('Move down')[0]);
    expect(settings.get('findCategoryOrder')).toEqual(before);
  });

  it('a text field follows a change made elsewhere, unless it has focus', () => {
    openSettings();
    const input = row('commentAuthorInitials').querySelector('input')!;
    const was = settings.get('commentAuthorInitials');
    settings.set('commentAuthorInitials', 'ZZ');
    expect(input.value).toBe('ZZ');
    input.focus();
    settings.set('commentAuthorInitials', 'QQ');
    expect(input.value).toBe('ZZ');
    input.blur();
    settings.set('commentAuthorInitials', was);
  });

  it('acronyms: one blank row at a time, and no repeated phrase', () => {
    settings.set('acronymPatterns', [{ phrase: 'nuclear weapons', chars: [0] }]);
    openSettings();
    const r = row('acronymPatterns');
    const add = [...r.querySelectorAll('button')].find((b) => b.textContent === '+ Add phrase')!;
    add.click();
    add.click();
    expect(settings.get('acronymPatterns')).toHaveLength(2);
    const blank = r.querySelectorAll<HTMLInputElement>('.pmd-acronym-phrase')[1]!;
    blank.value = 'Nuclear Weapons ';
    blank.dispatchEvent(new Event('input', { bubbles: true }));
    blank.dispatchEvent(new Event('change', { bubbles: true }));
    expect(settings.get('acronymPatterns')).toEqual([{ phrase: 'nuclear weapons', chars: [0] }]);
    expect(showToast).toHaveBeenCalled();
    settings.set('acronymPatterns', []);
  });

  it('shrink protections: a repeated pattern is dropped', () => {
    settings.set('shrinkCustomProtections', [
      { pattern: 'abc', isRegex: false },
      { pattern: '', isRegex: false },
    ]);
    openSettings();
    const second = row('shrinkCustomProtections').querySelectorAll<HTMLInputElement>(
      '.pmd-shrink-protection-pattern',
    )[1]!;
    second.value = 'abc';
    second.dispatchEvent(new Event('change', { bubbles: true }));
    expect(settings.get('shrinkCustomProtections')).toEqual([{ pattern: 'abc', isRegex: false }]);
    settings.set('shrinkCustomProtections', []);
  });

  it('custom condense markers: a note while one is missing', () => {
    const was = settings.get('condenseWarningDelimiter');
    openSettings();
    const note = row('condenseWarningDelimiter').querySelector<HTMLElement>('.pmd-autocorrect-warning')!;
    settings.set('condenseWarningCustomPauseMarker', '');
    settings.set('condenseWarningDelimiter', 'custom');
    expect(note.hidden).toBe(false);
    settings.set('condenseWarningCustomPauseMarker', '[P]');
    settings.set('condenseWarningCustomResumeMarker', '[R]');
    expect(note.hidden).toBe(true);
    settings.set('condenseWarningDelimiter', was);
    settings.set('condenseWarningCustomPauseMarker', '');
    settings.set('condenseWarningCustomResumeMarker', '');
  });
});

describe('screen-reader names', () => {
  it('every control in the dialog has one', async () => {
    settings.set('pairingPartners', [{ label: 'Ann', code: 'aaaa-bbbb' }] as never);
    settings.set('pairingGroups', [{ label: 'Team', memberCodes: ['aaaa-bbbb'] }] as never);
    settings.set('shrinkCustomProtections', [{ pattern: 'x', isRegex: false }]);
    settings.set('acronymPatterns', [{ phrase: 'nuclear weapons', chars: [0] }]);
    settings.set('timerSoundEnabled', true);
    openSettings();
    // Some buttons get their text from an async status read.
    await new Promise((r) => setTimeout(r, 0));
    const named = (el: Element): boolean => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return true;
      if (el.getAttribute('title') || el.getAttribute('placeholder')) return true;
      if (el.closest('label')?.textContent?.trim()) return true;
      if (el.id && document.querySelector(`label[for="${el.id}"]`)) return true;
      return el.tagName === 'BUTTON' && !!el.textContent?.trim();
    };
    const unnamed = [
      ...document.querySelectorAll('.pmd-settings-dialog :is(input, select, textarea, button)'),
    ]
      .filter((el) => (el as HTMLElement).style.display !== 'none' && !named(el))
      .map((el) => {
        const key = el.closest('[data-setting-key]')?.getAttribute('data-setting-key');
        return `${key ?? '?'}: ${el.tagName.toLowerCase()}.${el.className}`;
      });
    settings.set('shrinkCustomProtections', []);
    settings.set('acronymPatterns', []);
    expect(unnamed).toEqual([]);
  });
});

describe('earlier versions', () => {
  type Host = Parameters<typeof buildEarlierVersionsRow>[0];
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const fakeHost = (over: Record<string, unknown>): Host =>
    ({
      listEarlierVersions: async () => ({
        ok: true,
        current: '1.15.5',
        releasesUrl: 'https://github.com/brian-cai/cardmirror/releases',
        supported: true,
        reason: null,
        versions: [
          { version: '1.15.4', publishedAt: '2026-10-13T04:00:00Z' },
          { version: '1.15.3', publishedAt: '' },
        ],
      }),
      installEarlierVersion: async () => ({ ok: true }),
      updateChipAction: async () => {},
      openExternal: async () => {},
      ...over,
    }) as unknown as Host;
  const parts = (el: HTMLElement) => {
    const buttons = [...el.querySelectorAll('button')];
    return {
      show: buttons.find((b) => b.textContent === 'Show earlier versions')!,
      go: buttons.find((b) => b.textContent === 'Go back to this version')!,
      select: el.querySelector('select')!,
      status: el.querySelector<HTMLElement>('[role="status"]')!,
    };
  };

  afterEach(() => settings.set('checkForUpdatesOnLaunch', true));

  it('going back turns off automatic checks, then restarts', async () => {
    const calls: string[] = [];
    const el = buildEarlierVersionsRow(
      fakeHost({
        installEarlierVersion: async (v: string) => {
          calls.push(`install ${v}`);
          return { ok: true };
        },
        updateChipAction: async () => {
          calls.push(`restart auto=${settings.get('checkForUpdatesOnLaunch')}`);
        },
      }),
    );
    const { show, go, select } = parts(el);
    expect(select.hidden).toBe(true);
    show.click();
    await tick();
    expect([...select.options].map((o) => o.value)).toEqual(['1.15.4', '1.15.3']);
    expect(go.hidden).toBe(false);
    select.value = '1.15.3';
    go.click();
    await tick();
    expect(calls).toEqual(['install 1.15.3', 'restart auto=false']);
  });

  it('a cancelled or failed switch changes nothing', async () => {
    let restarted = false;
    const el = buildEarlierVersionsRow(
      fakeHost({
        installEarlierVersion: async () => ({ ok: false, error: 'no signature' }),
        updateChipAction: async () => {
          restarted = true;
        },
      }),
    );
    const { show, go, status } = parts(el);
    show.click();
    await tick();
    go.click();
    await tick();
    expect(restarted).toBe(false);
    expect(settings.get('checkForUpdatesOnLaunch')).toBe(true);
    expect(status.textContent).toBe('no signature');
    expect(go.disabled).toBe(false);
  });

  it('an install that cannot replace itself gets the reason, not the button', async () => {
    const el = buildEarlierVersionsRow(
      fakeHost({
        listEarlierVersions: async () => ({
          ok: true,
          current: '1.15.5',
          releasesUrl: 'https://example.invalid/releases',
          supported: false,
          reason: 'Move it to the Applications folder.',
          versions: [{ version: '1.15.4', publishedAt: '' }],
        }),
      }),
    );
    const { show, go, status } = parts(el);
    show.click();
    await tick();
    expect(go.hidden).toBe(true);
    expect(status.textContent).toBe('Move it to the Applications folder.');
  });
});
