// @vitest-environment jsdom
/**
 * Sharing is never hidden (sharing-setup.ts): before collaboration is set
 * up, the Send / Receive pills still show, and clicking one offers setup
 * (import a team file, or the Collaboration settings) instead of nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SendPillController } from '../../src/editor/pairing/send-pill-ui.js';
import { ReceivePillController } from '../../src/editor/pairing/receive-pill-ui.js';
import { settings } from '../../src/editor/settings.js';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function mountPills(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  new SendPillController().mount({ parent });
  new ReceivePillController().mount({ parent, getFocusedView: () => null });
  return parent;
}

beforeEach(() => settings.set('pairingEnabled', false));
afterEach(() => {
  document.body.innerHTML = '';
  settings.set('pairingEnabled', false);
});

describe('sharing before setup', () => {
  it('the Send and Receive pills show even with collaboration off', () => {
    const parent = mountPills();
    expect((parent.querySelector('.pmd-send-pill') as HTMLElement).hidden).toBe(false);
    expect((parent.querySelector('.pmd-receive-pill') as HTMLElement).hidden).toBe(false);
  });

  it.each([
    ['Send', '.pmd-send-bar'],
    ['Receive', '.pmd-receive-bar'],
  ])('clicking %s offers to set sharing up', async (_name, bar) => {
    const parent = mountPills();
    (parent.querySelector(bar) as HTMLElement).click();
    await tick();
    await tick();
    const labels = [...document.querySelectorAll('.pmd-route-btn strong')].map((b) => b.textContent);
    expect(labels).toEqual(['Import a team file', 'Set up in Settings']);
    expect(document.querySelector('.pmd-route-header')?.textContent).toBe('Set up card sharing and co-editing');
  });

  it('once sharing is on, clicking Send opens the send panel, not setup', async () => {
    settings.set('pairingEnabled', true);
    const parent = mountPills();
    (parent.querySelector('.pmd-send-bar') as HTMLElement).click();
    await tick();
    expect(document.querySelector('.pmd-route-dialog')).toBeNull();
  });
});
