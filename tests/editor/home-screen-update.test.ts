// @vitest-environment jsdom
/**
 * Home-screen update button: the status-bar update chip sits under the
 * home overlay, so home carries its own copy, wired through the same
 * update-chip host (issue #86).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { homeScreen, type HomeScreenCallbacks } from '../../src/editor/home-screen.js';
import { initUpdateChip, type UpdateChipState } from '../../src/editor/update-chip.js';

function baseCallbacks(): HomeScreenCallbacks {
  return {
    newDoc: vi.fn(),
    newSpeechDoc: vi.fn(),
    open: vi.fn(),
    openRecent: vi.fn(),
    manageQuickCards: vi.fn(),
  };
}

describe('home-screen update button', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('stays hidden when no update host is wired', () => {
    homeScreen.mount(document.body, baseCallbacks());
    const btn = document.querySelector<HTMLButtonElement>('.pmd-home-update');
    expect(btn).not.toBeNull();
    expect(btn!.hidden).toBe(true);
  });

  it('shows the host-reported update and forwards clicks', async () => {
    let push: ((s: UpdateChipState | null) => void) | null = null;
    const action = vi.fn(() => Promise.resolve());
    const host = {
      getUpdateChipState: () => Promise.resolve(null),
      updateChipAction: action,
      onUpdateChip: (h: (s: UpdateChipState | null) => void) => {
        push = h;
        return () => {};
      },
    };
    homeScreen.mount(document.body, {
      ...baseCallbacks(),
      mountUpdateChip: (el) => initUpdateChip(el, host),
    });
    await Promise.resolve();
    const btn = document.querySelector<HTMLButtonElement>('.pmd-home-update')!;
    expect(btn.hidden).toBe(true);

    push!({ state: 'ready', version: '1.14.0' });
    expect(btn.hidden).toBe(false);
    expect(btn.textContent).toContain('1.14.0');

    btn.click();
    expect(action).toHaveBeenCalledOnce();

    push!(null);
    expect(btn.hidden).toBe(true);
  });
});
