/**
 * Link to Extinction.GG's hosted relay (xtgg): a team that has no relay
 * of its own can get one there instead of self-hosting. Shown under the
 * Custom relay URL setting.
 */
import { getElectronHost } from './host/index.js';

export const HOSTED_RELAY_URL = 'https://extinction.gg/relay';

/** "No relay of your own? Get a hosted relay ↗". On desktop the click goes
 *  through the host so it opens in the OS browser, not an Electron window. */
export function buildHostedRelayLink(className = 'pmd-hosted-relay-link'): HTMLElement {
  const p = document.createElement('span');
  p.className = className;
  p.append('No relay of your own? ');
  const link = document.createElement('a');
  link.href = HOSTED_RELAY_URL;
  link.textContent = 'Get a hosted relay at extinction.gg/relay ↗';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'A hosted relay for your team: card sharing and co-editing with nothing to set up';
  link.addEventListener('click', (e) => {
    // Inside the row's <label>: don't focus or toggle its control.
    e.stopPropagation();
    const electron = getElectronHost();
    if (electron) {
      e.preventDefault();
      void electron.openExternal(HOSTED_RELAY_URL);
    }
  });
  p.appendChild(link);
  return p;
}
