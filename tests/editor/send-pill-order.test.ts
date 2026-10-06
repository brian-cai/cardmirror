// @vitest-environment jsdom
/** The Send pill reads upward from its search box: people on top, GROUPS
 *  right above the search box (most sends go to a whole team), search box
 *  last. */
import { afterEach, describe, expect, it } from 'vitest';
import { SendPillController } from '../../src/editor/pairing/send-pill-ui.js';
import { settings } from '../../src/editor/settings.js';

afterEach(() => {
  document.body.innerHTML = '';
  settings.set('pairingEnabled', false);
  settings.set('pairingPartners', []);
  settings.set('pairingGroups', []);
});

describe('send pill order', () => {
  it('people, then groups, then the search box', () => {
    settings.set('pairingEnabled', true);
    settings.set('pairingPartners', [
      { code: 'cmk1.a', name: 'Ari' },
      { code: 'cmk1.b', name: 'Belman' },
    ]);
    settings.set('pairingGroups', [{ id: 'g1', label: 'Varsity', memberCodes: ['cmk1.a', 'cmk1.b'] }]);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new SendPillController().mount({ parent });
    const panel = parent.querySelector('.pmd-send-panel')!;
    const order = [...panel.children].map((el) =>
      el.classList.contains('pmd-send-section') ? `§${el.textContent}` : el.classList.contains('pmd-send-search') ? 'search' : (el.textContent ?? '').trim().split(/\s/)[0],
    );
    const iTo = order.indexOf('§To');
    const iGroups = order.indexOf('§Groups');
    const iSearch = order.indexOf('search');
    expect(iTo).toBeGreaterThanOrEqual(0);
    expect(iTo).toBeLessThan(iGroups);
    expect(iGroups).toBeLessThan(iSearch);
  });
});
