/**
 * The small gear at the end of the Send and Receive popups' action rows:
 * a shortcut to Settings → Collaboration (pairing code, contacts, relay,
 * account). Icon-only so it doesn't crowd the row's two labelled actions.
 *
 * Settings UI is loaded on demand (it's a lazily-split chunk), the same
 * way the command palette opens it.
 */

import { setIcon } from '../icons';
import { visibleCategoryTabs } from '../settings-categories.js';
import { settings } from '../settings.js';

/** Whether this host has a Collaboration settings tab to open (it's
 *  desktop-only). The gear isn't rendered where it would land nowhere. */
export function collabSettingsAvailable(): boolean {
  return visibleCategoryTabs().some((t) => t.id === 'pairing');
}

/** A gear button that runs `beforeOpen` (close the popup) and then opens
 *  Settings on the Collaboration tab. */
export function collabSettingsButton(className: string, beforeOpen: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${className} pmd-pill-settings`;
  btn.title = 'Collaboration settings';
  btn.setAttribute('aria-label', 'Collaboration settings');
  const icon = document.createElement('span');
  icon.className = 'pmd-send-action-icon';
  setIcon(icon, 'settings');
  btn.appendChild(icon);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    beforeOpen();
    void import('../settings-ui.js').then((m) => m.openSettings({ category: 'pairing' }));
  });
  return btn;
}

/** A globe button beside the gear: switch relays (saved relays + the
 *  built-in one) from a menu next to it. Only once there's a saved relay
 *  to switch to; null otherwise. The menu module loads on click. */
export function relaySwitchButton(className: string): HTMLButtonElement | null {
  if (settings.get('relayProfiles').length === 0) return null;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `${className} pmd-pill-settings pmd-pill-relay`;
  btn.title = 'Switch relay';
  btn.setAttribute('aria-label', 'Switch relay');
  const icon = document.createElement('span');
  icon.className = 'pmd-send-action-icon';
  setIcon(icon, 'globe');
  btn.appendChild(icon);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    void import('../collab/relay-profiles-ui.js').then((m) => m.toggleRelayMenu(btn));
  });
  return btn;
}
