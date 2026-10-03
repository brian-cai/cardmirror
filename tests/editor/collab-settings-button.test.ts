// @vitest-environment jsdom
/**
 * The gear in the Send / Receive popups: closes the popup, then opens
 * Settings on the Collaboration tab; only offered where that tab exists.
 */
import { describe, it, expect, vi } from 'vitest';

const openSettings = vi.fn();
vi.mock('../../src/editor/settings-ui.js', () => ({ openSettings }));

import {
  collabSettingsButton,
  collabSettingsAvailable,
} from '../../src/editor/pairing/collab-settings-button.js';
import { visibleCategoryTabs } from '../../src/editor/settings-categories.js';

describe('collabSettingsButton', () => {
  it('closes the popup, then opens Settings → Collaboration', async () => {
    const order: string[] = [];
    openSettings.mockImplementation(() => order.push('open'));
    const btn = collabSettingsButton('pmd-receive-action', () => order.push('close'));
    expect(btn.classList.contains('pmd-pill-settings')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Collaboration settings');
    btn.click();
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledWith({ category: 'pairing' }));
    expect(order).toEqual(['close', 'open']);
  });

  it('is available exactly where the Collaboration tab is', () => {
    expect(collabSettingsAvailable()).toBe(visibleCategoryTabs().some((t) => t.id === 'pairing'));
  });
});
