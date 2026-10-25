/**
 * Relay setup links — the renderer half of `xtgg-relay://join?url=…&token=…`.
 *
 * Main validates the link (apps/desktop/src/relay-join-link.ts) and forwards
 * `{ relayUrl, token }` here. Nothing is applied silently: the user confirms
 * in a dialog naming the relay (token masked), and only then do we write the
 * same three settings they would set by hand in Settings → Collaboration.
 * The settings subscriber in pairing-wiring.ts pushes the new relay to main,
 * and the rooms client resolves URL + token per request, so the new relay is
 * live without a restart.
 *
 * Desktop only: Lite has no collaboration, and the web edition has no
 * Electron host to deliver links.
 */

import { getElectronHost } from '../host/index.js';
import { collabEnabled } from '../collab/collab-gate.js';
import { isLiteBuild } from '../lite.js';
import { settings } from '../settings.js';
import { showConfirm } from '../confirm-dialog.js';
import { showToast } from '../toast.js';

/** Show enough of a token to recognize it, never all of it: the first 8
 *  characters, or half of a short one. */
export function maskRelayToken(token: string): string {
  const shown = Math.min(8, Math.floor(token.length / 2));
  return `${token.slice(0, shown)}…`;
}

/** True while a confirm is up, so a double-clicked link doesn't stack
 *  two dialogs. */
let confirming = false;

async function handleRelayJoin(link: { relayUrl: string; token: string }): Promise<void> {
  if (confirming) {
    console.log('[relay-join] ignored link: a relay confirm is already open');
    return;
  }
  const currentUrl = settings.get('pairingRelayUrl').trim().replace(/\/+$/, '');
  const currentToken = settings.get('pairingRelayToken').trim();
  const enabled = settings.get('pairingEnabled');
  if (enabled && currentUrl === link.relayUrl && currentToken === link.token) {
    showToast(`CardMirror is already connected to ${link.relayUrl}.`);
    return;
  }
  const lines = [`Relay: ${link.relayUrl}`, `Token: ${maskRelayToken(link.token)}`];
  if (currentUrl && currentUrl !== link.relayUrl) {
    lines.push('', `This replaces your current custom relay (${currentUrl}).`);
  } else if (currentToken && currentToken !== link.token) {
    lines.push('', 'This replaces your current custom relay token.');
  }
  if (!enabled) lines.push('', 'This also turns on collaboration.');
  confirming = true;
  let ok: boolean;
  try {
    ok = await showConfirm({
      title: 'Connect CardMirror to this relay?',
      message: lines.join('\n'),
      confirmLabel: 'Connect',
      cancelLabel: 'Cancel',
    });
  } finally {
    confirming = false;
  }
  if (!ok) return;
  // URL + token first, so switching collaboration on never connects to
  // the old relay in between.
  settings.set('pairingRelayUrl', link.relayUrl);
  settings.set('pairingRelayToken', link.token);
  settings.set('pairingEnabled', true);
  showToast(`Connected to ${link.relayUrl}.`);
}

/** Wire main's relay-join forward. Call once at boot. */
export function initRelayJoin(): void {
  if (isLiteBuild() || !collabEnabled()) return;
  getElectronHost()?.onRelayJoin((link) => {
    void handleRelayJoin(link);
  });
}
