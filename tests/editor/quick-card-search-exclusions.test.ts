// @vitest-environment jsdom
/**
 * File-search exclusions (2026-07-29): paths in the `fileSearchExclusions`
 * setting never surface in the palette — not in `f` browse, not in the
 * everything search — and the ⊘ button on a file row adds an exclusion
 * after an explicit confirm. Drives the real singleton with a mocked
 * Electron host, like the paging suite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hostState = vi.hoisted(() => ({
  files: [] as Array<{ path: string; relPath: string; mtimeMs: number; size: number }>,
}));

vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      readFileAtPath: async () => null,
    }),
  };
});

// The palette talks to the file-index service via this client — the
// fake runs the REAL matcher over hostState.files (see _fake-file-index).
vi.mock('../../src/editor/file-search-client.js', async () => {
  const { makeFakeFileIndexClient } = await import('./_fake-file-index.js');
  return {
    getFileIndexClient: async () => makeFakeFileIndexClient(hostState),
    setFileIndexClientForTests: () => {},
  };
});

import { quickCardSearchUI } from '../../src/editor/quick-card-search-ui.js';
import { settings } from '../../src/editor/settings.js';

function openPalette(): void {
  quickCardSearchUI.open({
    view: null,
    paneEl: null,
    runCommand: () => {},
    openFilePath: () => {},
  });
}

function type(q: string): void {
  const input = document.querySelector<HTMLInputElement>('.pmd-qcs-input')!;
  input.value = q;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const rowNames = (): string[] =>
  [...document.querySelectorAll('.pmd-qcs-row-name')].map((el) => el.textContent ?? '');

/** Let the async service query round-trip + re-search settle. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  hostState.files = [
    { path: '/root/Warming Aff.cmir', relPath: 'Aff/Warming Aff.cmir', mtimeMs: 3, size: 1 },
    { path: '/root/Warming Neg.cmir', relPath: 'Neg/Warming Neg.cmir', mtimeMs: 2, size: 1 },
    { path: '/root/Private/Warming Prep.cmir', relPath: 'Private/Warming Prep.cmir', mtimeMs: 1, size: 1 },
  ];
  settings.set('fileSearchRoots', ['/root']);
  settings.set('fileSearchExclusions', []);
});

afterEach(() => {
  if (quickCardSearchUI.isOpen()) quickCardSearchUI.close();
  settings.set('fileSearchExclusions', []);
  document.body.innerHTML = '';
});

describe('palette file-search exclusions', () => {
  it('an excluded file never lists (f browse and everything search)', async () => {
    settings.set('fileSearchExclusions', ['/root/Warming Neg.cmir']);
    openPalette();
    await settle();
    type('f ');
    await settle();
    expect(rowNames()).toEqual(['Warming Aff', 'Warming Prep']);
    type('warming'); // everything search folds files in — still excluded
    await settle();
    expect(rowNames()).toContain('Warming Aff');
    expect(rowNames()).not.toContain('Warming Neg');
  });

  it('an excluded FOLDER hides everything under it, separator-aware', async () => {
    settings.set('fileSearchExclusions', ['/root/Private']);
    openPalette();
    await settle();
    type('f ');
    await settle();
    expect(rowNames()).toEqual(['Warming Aff', 'Warming Neg']);
  });

  it('the ⊘ button confirms, adds the exclusion, and drops the row live', async () => {
    openPalette();
    await settle();
    type('f ');
    await settle();
    expect(rowNames()).toHaveLength(3);

    const negRow = [...document.querySelectorAll('.pmd-qcs-row')].find((r) =>
      r.textContent?.includes('Warming Neg'),
    )!;
    negRow.querySelector<HTMLElement>('.pmd-qcs-exclude')!.click();

    // Confirm dialog is up; nothing changed yet.
    const dialog = document.querySelector('.pmd-route-dialog');
    expect(dialog).not.toBeNull();
    expect(settings.get('fileSearchExclusions')).toEqual([]);
    expect(rowNames()).toHaveLength(3);

    const confirmBtn = [...dialog!.querySelectorAll('button')].find(
      (b) => b.textContent === 'Exclude',
    )!;
    confirmBtn.click();
    await settle();

    expect(settings.get('fileSearchExclusions')).toEqual(['/root/Warming Neg.cmir']);
    expect(rowNames()).toEqual(['Warming Aff', 'Warming Prep']);
  });

  it('cancelling the confirm leaves everything untouched', async () => {
    openPalette();
    await settle();
    type('f ');
    await settle();
    document.querySelector<HTMLElement>('.pmd-qcs-exclude')!.click();
    const cancelBtn = [...document.querySelectorAll('.pmd-route-dialog button')].find(
      (b) => b.textContent === 'Cancel',
    ) as HTMLElement;
    cancelBtn.click();
    await settle();
    expect(settings.get('fileSearchExclusions')).toEqual([]);
    expect(rowNames()).toHaveLength(3);
  });
});
