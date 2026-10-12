// @vitest-environment jsdom

/**
 * Interface size / nav text size rows: the interface slider only moves
 * the number while dragging and applies on release; the box takes a
 * typed percent; the nav text slider still applies as it moves.
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

// jsdom lacks ResizeObserver (the modal's tab-strip arrows use one).
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= FakeResizeObserver;

afterEach(() => {
  closeSettings();
  settings.set('chromeScalePct', 100);
  settings.set('navTextScale', 100);
});

function controls(label: string): { range: HTMLInputElement; box: HTMLInputElement } {
  const range = document.querySelector<HTMLInputElement>(`.pmd-percent-slider input[type="range"][aria-label="${label}"]`);
  if (!range) throw new Error(`no slider: ${label}`);
  const box = range.parentElement!.querySelector<HTMLInputElement>('input[type="number"]')!;
  return { range, box };
}

function fire(el: HTMLInputElement, value: string, type: 'input' | 'change'): void {
  el.value = value;
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

describe('percent size rows', () => {
  it('interface size: dragging only moves the number; release applies', () => {
    openSettings();
    const { range, box } = controls('Interface size');
    fire(range, '150', 'input');
    expect(box.value).toBe('150');
    expect(settings.get('chromeScalePct')).toBe(100);
    fire(range, '150', 'change');
    expect(settings.get('chromeScalePct')).toBe(150);
  });

  it('interface size: a typed percent applies on commit, clamped to the range', () => {
    openSettings();
    const { box } = controls('Interface size');
    fire(box, '112', 'input');
    expect(settings.get('chromeScalePct')).toBe(100);
    fire(box, '112', 'change');
    expect(settings.get('chromeScalePct')).toBe(112);
    fire(box, '900', 'change');
    expect(settings.get('chromeScalePct')).toBe(300);
    expect(box.value).toBe('300');
    fire(box, '', 'change');
    expect(settings.get('chromeScalePct')).toBe(300);
    expect(box.value).toBe('300');
  });

  it('nav text size: still applies while dragging', () => {
    openSettings();
    const { range } = controls('Nav pane text size');
    fire(range, '130', 'input');
    expect(settings.get('navTextScale')).toBe(130);
  });
});
