/**
 * Link to Extinction.GG's speaking-speed check (xtgg): read a passage aloud
 * and get your words per minute, the number the reader rows ask for. Shown
 * under the readers editor in Settings (desktop and mobile).
 */
import { getElectronHost } from './host/index.js';

export const WPM_TEST_URL = 'https://extinction.gg/wpm';

/** "Don't know your speed? Measure your wpm ↗". On desktop the click goes
 *  through the host so it opens in the OS browser, not an Electron window. */
export function buildWpmTestLink(className = 'pmd-wpm-test'): HTMLElement {
  const p = document.createElement('p');
  p.className = className;
  p.append("Don't know your speed? ");
  const link = document.createElement('a');
  link.href = WPM_TEST_URL;
  link.textContent = 'Measure your wpm ↗';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Read a passage aloud on extinction.gg/wpm and get your words per minute';
  link.addEventListener('click', (e) => {
    const electron = getElectronHost();
    if (electron) {
      e.preventDefault();
      void electron.openExternal(WPM_TEST_URL);
    }
  });
  p.appendChild(link);
  return p;
}
