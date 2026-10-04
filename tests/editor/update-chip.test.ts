// @vitest-environment jsdom
/**
 * Update chip (install-on-confirm, 2026-07-16): the status-bar chip is
 * the ONLY auto-update surface — no dialogs. It renders the staged
 * ('ready') and detected-but-not-stageable ('available') states, pulls
 * the current state at boot (late-opened windows), tracks pushed
 * changes, and forwards clicks to the host's action.
 */
import { describe, expect, it } from 'vitest';
import {
  initUpdateChip,
  renderUpdateChip,
  type UpdateChipHost,
  type UpdateChipState,
} from '../../src/editor/update-chip.js';

function makeEl(): HTMLButtonElement {
  const el = document.createElement('button');
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

function makeHost(initial: UpdateChipState | null): UpdateChipHost & {
  actions: number;
  push: (s: UpdateChipState | null) => void;
} {
  let handler: ((s: UpdateChipState | null) => void) | null = null;
  const host = {
    actions: 0,
    push: (s: UpdateChipState | null) => handler?.(s),
    getUpdateChipState: () => Promise.resolve(initial),
    updateChipAction: () => {
      host.actions++;
      return Promise.resolve();
    },
    onUpdateChip: (h: (s: UpdateChipState | null) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
  };
  return host;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r));

describe('update chip', () => {
  it('renders ready and available states; null hides', () => {
    const el = makeEl();
    renderUpdateChip(el, { state: 'ready', version: '0.1.0-beta.15' });
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('Update 0.1.0-beta.15 ready — restart to install');
    renderUpdateChip(el, { state: 'available', version: '0.1.0-beta.15' });
    expect(el.textContent).toBe('Update 0.1.0-beta.15 available');
    renderUpdateChip(el, null);
    expect(el.hidden).toBe(true);
  });

  it('pulls the initial state at boot (late-opened window case)', async () => {
    const el = makeEl();
    initUpdateChip(el, makeHost({ state: 'ready', version: '1.2.3' }));
    await tick();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('1.2.3');
  });

  it('tracks pushed state changes', async () => {
    const el = makeEl();
    const host = makeHost(null);
    initUpdateChip(el, host);
    await tick();
    expect(el.hidden).toBe(true);
    host.push({ state: 'ready', version: '2.0.0' });
    expect(el.hidden).toBe(false);
    host.push(null);
    expect(el.hidden).toBe(true);
  });

  it('click forwards to the host action', async () => {
    const el = makeEl();
    const host = makeHost({ state: 'ready', version: '1.0.0' });
    initUpdateChip(el, host);
    await tick();
    el.click();
    expect(host.actions).toBe(1);
  });

  it('status bar: idle shows "Check for updates"; a click checks and reports', async () => {
    const el = makeEl();
    const host = makeHost(null);
    let resolveCheck: (o: string) => void = () => {};
    initUpdateChip(el, host, { idleCheck: () => new Promise((r) => (resolveCheck = r)) });
    await tick();
    expect(el.hidden).toBe(false);
    expect(el.textContent).toBe('Check for updates');
    el.click();
    expect(el.textContent).toBe('Checking for updates…');
    el.click(); // a second click while checking is ignored
    resolveCheck('latest');
    await tick();
    expect(el.textContent).toBe('Up to date');
    expect(host.actions).toBe(0); // idle clicks never install
  });

  it('status bar: a pushed update replaces the idle control, and clicks install', async () => {
    const el = makeEl();
    const host = makeHost(null);
    initUpdateChip(el, host, { idleCheck: () => Promise.resolve('updating') });
    await tick();
    el.click();
    await tick();
    expect(el.textContent).toBe('Downloading update…');
    host.push({ state: 'ready', version: '1.14.5' });
    expect(el.textContent).toBe('Update 1.14.5 ready — restart to install');
    el.click();
    expect(host.actions).toBe(1);
  });

  it('without idleCheck (home screen copy), no update stays hidden', async () => {
    const el = makeEl();
    initUpdateChip(el, makeHost(null));
    await tick();
    expect(el.hidden).toBe(true);
  });
});
