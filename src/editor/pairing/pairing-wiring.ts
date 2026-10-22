/**
 * Pairing wiring — boot glue for cross-machine card sharing.
 *
 *   - Mounts the Send + Receive pills into the pill tray.
 *   - Mints this machine's own code the first time sharing is enabled.
 *   - Pushes the current pairing config to the main process (which runs
 *     the poller + holds the token) on boot and on every settings change.
 *   - Surfaces a toast when a partner is on a different app version.
 *
 * Desktop v1: everything routes through the Electron host. On the web
 * edition (no `getElectronHost()`) this is inert — the pills render but
 * there is no poller/sender yet (deferred).
 */

import type { EditorView } from 'prosemirror-view';
import { getElectronHost } from '../host/index.js';
import { collabEnabled } from '../collab/collab-gate.js';
import { isLiteBuild } from '../lite.js';
import { settings } from '../settings.js';
import { appVersion, CARD_COMPAT_MIN_VERSION } from '../install-info.js';
import { showToast } from '../toast.js';
import { RELAY_FIX_PATH } from '../relay-decline.js';
import { postNotice } from '../status-notices.js';
import { inboxStore } from './inbox-store.js';
import { SendPillController } from './send-pill-ui.js';
import { ReceivePillController } from './receive-pill-ui.js';
import { installContactsAutoExport } from './contacts-auto-export.js';
import { installTeamFileSync } from './team-file-sync.js';
import { customRelayExtHeaders } from '../collab/relay-info.js';
import { startRelayProfiles } from '../collab/relay-profiles-ui.js';

/** Build + mount the Send and Receive pills into the tray (after the
 *  dropzone, so they sit to its right). */
export function mountPairingPills(
  tray: HTMLElement,
  getFocusedView: () => EditorView | null,
): { receivePillEl: HTMLElement | null } {
  new SendPillController().mount({ parent: tray, getFocusedView });
  const receive = new ReceivePillController();
  receive.mount({ parent: tray, getFocusedView });
  // Returned so the shell can re-parent the receive pill into the home
  // screen's dock while home is up (invites must be joinable with no
  // doc open); the send pill and dropzone stay tray-only — they act on
  // the doc home covers.
  return { receivePillEl: receive.rootEl() };
}

/** Push the current settings to the main-process poller/sender. The main
 *  process owns this machine's keypair and returns its public code, which we
 *  mirror into settings for display + sharing. */
function applyConfig(): void {
  const cfg = {
    enabled: settings.get('pairingEnabled'),
    displayName: settings.get('pairingDisplayName'),
    schemaVersion: appVersion,
    minReceiverVersion: CARD_COMPAT_MIN_VERSION,
    pollSeconds: settings.get('pairingPollSeconds'),
    relayUrl: settings.get('pairingRelayUrl'),
    relayToken: settings.get('pairingRelayToken'),
    // Relay info v1: {} unless a custom relay is set.
    relayExtHeaders: customRelayExtHeaders(),
  };
  const mirrorOwnCode = ({ ownCode }: { ownCode: string }): void => {
    // Setting it re-fires the subscriber, but the value is now unchanged so
    // configure is a no-op next time — no loop.
    if (ownCode && settings.get('pairingOwnCode') !== ownCode) {
      settings.set('pairingOwnCode', ownCode);
    }
  };
  const electron = getElectronHost();
  if (electron?.pairingConfigure) {
    void electron.pairingConfigure(cfg).then(mirrorOwnCode);
    return;
  }
  // Web (Phase 4): the renderer mailbox is the poller/sender, gated on
  // the collab gate so plain web visits stay inert as before.
  if (!electron && collabEnabled()) {
    void import('./web-mailbox.js').then((m) =>
      m.webPairingConfigure(cfg).then(mirrorOwnCode).catch(() => {}),
    );
  }
}

/** Mint a fresh keypair in main and mirror the new code into settings.
 *  Invalidates the old code for partners (they must re-add the new one). */
export async function regenerateOwnCode(): Promise<void> {
  const electron = getElectronHost();
  if (electron?.pairingRegenerateKey) {
    const { ownCode } = await electron.pairingRegenerateKey();
    if (ownCode) settings.set('pairingOwnCode', ownCode);
    return;
  }
  if (!electron && collabEnabled()) {
    const m = await import('./web-mailbox.js');
    const { ownCode } = await m.webPairingRegenerateKey();
    if (ownCode) settings.set('pairingOwnCode', ownCode);
  }
}

let lastMismatchToast = 0;

/** Wire config sync + incoming-event handling. Idempotent-ish; call once
 *  at boot. */
export function initPairingWiring(): void {
  // Lite: card sharing does not exist — no inbox, no config pushes,
  // no relay wiring (also avoids invoking IPC handlers the Lite main
  // process deliberately never registers).
  if (isLiteBuild()) return;
  void inboxStore.init();
  // Desktop: keep the chosen contacts file (if any) in step with edits.
  installContactsAutoExport();
  installTeamFileSync();
  // Saved relays: save a custom relay once it connects, keep each relay's
  // team key, and show the relay chip once there's one to switch to.
  startRelayProfiles();
  // Relay info v1: on a custom relay, learn who runs it, this access's
  // standing and any notice (on start, then at most hourly). Loaded only
  // once a custom relay is set; the built-in relay never sees it.
  const startRelayInfo = (): boolean => {
    if (!settings.get('pairingRelayUrl').trim()) return false;
    void import('../collab/relay-info-ui.js').then((m) => m.startRelayInfo());
    // Team directory v1: offer the relay's team list once, then keep in
    // step with it (quiet unless the relay supports it).
    void import('../collab/team-directory-ui.js').then((m) => m.startTeamDirectory());
    return true;
  };
  if (!startRelayInfo()) {
    const off = settings.subscribe(() => {
      if (startRelayInfo()) off();
    });
  }

  const electron = getElectronHost();
  // Coming back to the app is when you're looking for an invite: check
  // the mailbox right away instead of trusting a possibly-dead stream.
  if (electron?.pairingPollNow) {
    window.addEventListener('focus', () => {
      if (settings.get('pairingEnabled')) void electron.pairingPollNow?.().catch(() => {});
    });
  }
  if (electron?.onPairingVersionMismatch) {
    electron.onPairingVersionMismatch((info) => {
      // Throttle so a backlog of incompatible cards doesn't spam toasts.
      const now = Date.now();
      if (now - lastMismatchToast < 8000) return;
      lastMismatchToast = now;
      const need = info.requiredVersion
        ? ` (${info.requiredVersion} or newer)`
        : '';
      showToast(
        `A shared card needs a newer CardMirror version${need} — ` +
          `update to receive it.`,
      );
    });
  }

  // Blog-account entitlement (dormant unless main enables the flow):
  // keep the settings mirror current and surface evictions — a user
  // whose seat was taken should learn it from a toast, not from cards
  // silently failing later.
  if (electron?.onPairingEntitlementChanged) {
    electron.onPairingEntitlementChanged((st) => {
      const mirror = st.connected ? st.expiresAt : 0;
      if (settings.get('pairingConnectedUntil') !== mirror) {
        settings.set('pairingConnectedUntil', mirror);
      }
      if (st.evicted) {
        showToast(
          'This machine was unlinked from your Debate Decoded account ' +
            '(another machine took the seat). Re-link from the connect page ' +
            'to keep using collaboration features here.',
        );
      }
    });
  }

  // Relay rejected our credentials (401): a wrong self-host token today,
  // or a missing subscription once gating enforces. Same two-path
  // framing as the co-editing session-start message — plus the beta
  // context, since the ungated official relay shouldn't 401 at all
  // (a wrong custom-relay token or a stale build is the likely cause).
  if (electron?.onPairingUnauthorized) {
    electron.onPairingUnauthorized((info) => {
      // A custom relay that explains itself (the install limit: how many
      // installs are in use, when idle ones stop counting, whom to ask)
      // gets its sentence shown whole — it, not us, knows the fix.
      const detail = info?.detail?.trim() ?? '';
      postNotice({
        severity: 'error',
        title: detail ? 'Your relay refused this install' : 'Card sharing needs credentials',
        body: detail
          ? `Card sharing: the relay refused this install: ${detail}`
          : 'Card sharing: the relay rejected your credentials. ' + RELAY_FIX_PATH,
        key: 'pairing-401',
        full: true,
      });
    });
  }

  // Web mismatch/decline surfaces mirror the desktop handlers above.
  if (!electron && collabEnabled()) {
    void import('./web-mailbox.js').then((m) => {
      m.onWebPairingVersionMismatch((info) => {
        const now = Date.now();
        if (now - lastMismatchToast < 8000) return;
        lastMismatchToast = now;
        const need = info.requiredVersion ? ` (${info.requiredVersion} or newer)` : '';
        showToast(
          `A shared card needs a newer CardMirror version${need} — update to receive it.`,
        );
      });
      m.onWebPairingAccountRequired(() => {
        postNotice({
          severity: 'warning',
          title: 'Receiving cards in-browser needs your account',
          body:
            'Card sharing is turned on, but this browser is not connected ' +
            'to a Debate Decoded account or private relay — cards sent to ' +
            'you will not be delivered and will expire after 3 hours. ' +
            'Connect in Settings → Collaboration to receive them.',
          key: 'pairing-account-required',
        });
      });
      m.onWebPairingUnauthorized(() => {
        postNotice({
          severity: 'error',
          title: 'Card sharing needs credentials',
          body: 'Card sharing: the relay rejected your credentials. ' + RELAY_FIX_PATH,
          key: 'pairing-401',
        });
      });
    });
  }

  applyConfig();
  settings.subscribe(() => applyConfig());
}
