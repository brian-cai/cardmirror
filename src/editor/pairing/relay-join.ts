/**
 * Relay setup links — the renderer half of `xtgg-relay://join?url=…&token=…`.
 *
 * Main validates the link (apps/desktop/src/relay-join-link.ts) and forwards
 * `{ relayUrl, token }` here — or `{ error }` for a link it couldn't use, so
 * a bad link says so instead of doing nothing. A link pasted into the app
 * (the Join box, the sharing setup offer) goes through the same parser via
 * `joinRelayFromText`.
 *
 * Nothing is applied silently: one Connect dialog names the team and the
 * relay (from the relay's own info and team list when it answers, else
 * its host — the token is never shown), asks for a display name when there
 * is none, and only then writes the relay settings, in ONE settings change
 * (URL and token together: two writes let main send the old token to the
 * new relay). Connect then adds the team list with no second prompt
 * (team-directory-ui.ts importTeamAfterConnect).
 *
 * Desktop only: Lite has no collaboration (its link gets an explanation),
 * and the web edition has no Electron host to deliver links.
 */

import { getElectronHost } from '../host/index.js';
import { collabEnabled } from '../collab/collab-gate.js';
import { isLiteBuild } from '../lite.js';
import { settings } from '../settings.js';
import { showConfirm } from '../confirm-dialog.js';
import { showToast } from '../toast.js';
import { readRelayInviteText } from './relay-invite-text.js';
// The relay client, team list and saved-relay modules load only when a
// link arrives: this module is on the startup path (and in Lite).

/** Show enough of a token to recognize it, never all of it: the first 8
 *  characters, or half of a short one. */
export function maskRelayToken(token: string): string {
  const shown = Math.min(8, Math.floor(token.length / 2));
  return `${token.slice(0, shown)}…`;
}

export const BAD_INVITE_LINK = 'This invite link didn’t work. Ask your coach to resend it.';
const LITE_INVITE_LINK =
  'Invite links join a team relay, and CardMirror Lite has no card sharing or co-editing. Use the full CardMirror (BCai’s build) for this.';

/** What the relay says about itself, for the Connect dialog. Best effort:
 *  any failure or a slow relay leaves the fields empty. */
export interface RelayDescription {
  host: string;
  operator: string;
  team: string;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Ask the link's relay its name and team, with the link's own token (it
 *  belongs to that relay; nothing of this computer's is sent). */
export async function describeRelay(
  link: { relayUrl: string; token: string },
  timeoutMs = 3000,
  fetchImpl?: typeof fetch,
): Promise<RelayDescription> {
  const out: RelayDescription = { host: hostOf(link.relayUrl), operator: '', team: '' };
  const [{ RoomsClient }, { parseRelayInfo }, { parseTeamDirectory }, { appVersion }, { relayExtHeaders }] = await Promise.all([
    import('../collab/room-client.js'),
    import('../collab/relay-info.js'),
    import('../collab/team-directory.js'),
    import('../install-info.js'),
    import('../relay-protocol.js'),
  ]);
  const client = new RoomsClient({
    baseUrl: () => link.relayUrl,
    token: () => link.token,
    routingCode: () => '',
    // The build's id only: no install name before the user says Connect.
    extHeaders: () => relayExtHeaders({ version: appVersion, installName: '' }),
    requestTimeoutMs: timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const [info, dir] = await Promise.allSettled([client.relayInfo(), client.getTeamDirectory()]);
  if (info.status === 'fulfilled') out.operator = parseRelayInfo(info.value)?.operator?.name ?? '';
  if (dir.status === 'fulfilled' && dir.value) out.team = parseTeamDirectory(dir.value)?.name.trim() ?? '';
  return out;
}

/** The Connect dialog's text. `name`: the display name you'd be listed
 *  under ('' = the dialog asks for one). Exported for tests. */
export function connectDialogText(
  d: RelayDescription,
  ctx: { currentUrl: string; currentToken: string; enabled: boolean; relayUrl: string; token: string; name?: string },
): { title: string; message: string } {
  const title = d.team ? `Join ${d.team} in CardMirror?` : 'Connect CardMirror to your team’s relay?';
  const lines = [`Relay: ${d.operator ? `${d.operator} (${d.host})` : d.host}`];
  if (ctx.currentUrl && ctx.currentUrl !== ctx.relayUrl) {
    lines.push('', `This replaces the relay you use now (${hostOf(ctx.currentUrl)}).`);
  } else if (ctx.currentToken && ctx.currentToken !== ctx.token) {
    lines.push('', 'This replaces your current access to this relay.');
  }
  lines.push(
    '',
    ctx.enabled
      ? 'Connect adds your teammates so you can send cards and co-edit.'
      : 'Connect turns on card sharing and co-editing and adds your teammates.',
    // Connect also joins the team's list (importTeamAfterConnect): say so,
    // as the old separate name prompt did.
    `It also lists you on your team’s list ${ctx.name?.trim() ? `as “${ctx.name.trim()}”` : 'under the name below'} with ` +
      'your send code, so teammates who connect get you as a contact.',
  );
  return { title, message: lines.join('\n') };
}

/** True while a confirm is up, so a double-clicked link doesn't stack
 *  two dialogs. */
let confirming = false;

/** `unsolicited`: the link came from another app (the OS handed it over,
 *  maybe mid-typing), not a paste into CardMirror. */
async function handleRelayJoin(link: { relayUrl: string; token: string }, opts: { unsolicited: boolean }): Promise<void> {
  if (confirming) {
    console.log('[relay-join] ignored link: a relay confirm is already open');
    return;
  }
  const currentUrl = settings.get('pairingRelayUrl').trim().replace(/\/+$/, '');
  const currentToken = settings.get('pairingRelayToken').trim();
  const enabled = settings.get('pairingEnabled');
  if (enabled && currentUrl === link.relayUrl && currentToken === link.token) {
    showToast(`CardMirror is already connected to ${hostOf(link.relayUrl)}.`);
    return;
  }
  confirming = true;
  let ok: boolean;
  let typedName = '';
  const needName = !settings.get('pairingDisplayName').trim();
  try {
    const d = await describeRelay(link).catch((): RelayDescription => ({ host: hostOf(link.relayUrl), operator: '', team: '' }));
    const t = connectDialogText(d, { currentUrl, currentToken, enabled, ...link, name: settings.get('pairingDisplayName') });
    ok = await showConfirm({
      title: t.title,
      message: t.message,
      confirmLabel: 'Connect',
      cancelLabel: 'Cancel',
      // A link from another app, maybe mid-typing: Cancel holds the focus
      // and the first second of keys is ignored. A paste is the user's
      // own action (the Join box, the sharing setup) and asks normally.
      unsolicited: opts.unsolicited,
      ...(needName
        ? {
            field: {
              label: 'Your name (what teammates see)',
              placeholder: 'e.g. Ana Lopez',
              onInput: (v: string) => (typedName = v),
            },
          }
        : {}),
    });
  } finally {
    confirming = false;
  }
  if (!ok) return;
  // One settings change for URL + token (adoptRelay: a switch, so the
  // outgoing relay keeps its team key), then sharing on and the name.
  const { adoptRelay } = await import('../collab/relay-profiles.js');
  adoptRelay(link.relayUrl, link.token);
  const name = typedName.trim().slice(0, 80);
  settings.setMany({ pairingEnabled: true, ...(name && needName ? { pairingDisplayName: name } : {}) });
  showToast(
    settings.get('pairingDisplayName').trim()
      ? `Connected to ${hostOf(link.relayUrl)}. Adding your teammates…`
      : `Connected to ${hostOf(link.relayUrl)}. Add your name in Settings → Collaboration so teammates can find you.`,
  );
  void import('../collab/team-directory-ui.js').then((m) => m.importTeamAfterConnect()).catch(() => {});
}

/** A pasted invite link (the Join box, the sharing setup offer). Resolves
 *  false when `text` isn't an invite link at all, so the caller can treat
 *  it as something else (a session code); true once handled, including a
 *  broken link (which says so). */
export async function joinRelayFromText(text: string): Promise<boolean> {
  const read = readRelayInviteText(text);
  if (read.kind === 'none') return false;
  if (read.kind === 'broken') {
    showToast(BAD_INVITE_LINK);
    return true;
  }
  if (isLiteBuild()) {
    showToast(LITE_INVITE_LINK);
    return true;
  }
  const electron = getElectronHost();
  if (!electron) {
    showToast('Invite links work in the CardMirror desktop app.');
    return true;
  }
  const parsed = await electron.relayJoinParse(read.link).catch(() => ({ ok: false as const, reason: 'ipc' }));
  if (!parsed.ok) {
    showToast(BAD_INVITE_LINK);
    return true;
  }
  await handleRelayJoin(parsed.link, { unsolicited: false });
  return true;
}

/** Wire main's relay-join forward. Call once at boot. Lite listens too,
 *  only to say why the link does nothing there. */
export function initRelayJoin(): void {
  const lite = isLiteBuild();
  if (!lite && !collabEnabled()) return;
  getElectronHost()?.onRelayJoin((payload) => {
    if ('error' in payload) {
      showToast(payload.error === 'lite' || lite ? LITE_INVITE_LINK : BAD_INVITE_LINK);
      return;
    }
    if (lite) {
      showToast(LITE_INVITE_LINK);
      return;
    }
    void handleRelayJoin(payload, { unsolicited: true });
  });
}
