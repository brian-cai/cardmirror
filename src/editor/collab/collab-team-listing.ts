/**
 * Team sessions wiring for a live session (relay extension; see team-sessions.ts): listing and relisting it, the host's "who's in it" refresh, join-request approval, and the Join dialog's team section. Plus the shared invite-send tail. Split out of collab-ui.ts.
 */

import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { offerSharingSetup } from '../pairing/sharing-setup.js';
import { getElectronHost } from '../host/index.js';
import { relayClient, relayBaseUrl } from './collab-relay.js';
import { alreadyRequested, approveJoinRequest, denyJoinRequest, listRoom, listedMode, loadTeamSessions, requestToJoin, watchJoinRequests, type PendingJoinRequest, type TeamContext } from './team-sessions.js';
import { clearJoinRequests, setJoinRequests, unhideJoinRequest } from './team-sessions-ui.js';
import { TEAM_REQUEST_SENT_MESSAGE, type TeamSessionsSource } from './rejoin-picker.js';
import { isTeamKey } from '../pairing/team-key.js';
import { looksLikePairingCode, normalizePairingCode } from '../pairing/pairing-ids.js';
import { relayClient as pairingRelayClient } from '../pairing/relay-client.js';
import { buildRoomInviteItem, roomInviteFloor } from '../pairing/room-invite.js';
import { collabEnabled } from './collab-gate.js';
import { CollabSession } from './collab-session.js';
import { actionSession, roomLiveInWindow, sessionFor, sessions } from './collab-ui-state.js';
import { sessionDocTitle, sessionLabel } from './collab-titles.js';

/** Shared invite-send tail: sealed pairing message, version-floored so
 *  pre-invite clients get the update-required toast instead of a dead
 *  card row. Assumes an active session. */
export async function sendInviteTo(
  target: { codes: string[]; label: string; via?: string },
  shareCode: string,
  ownerUid: string | null | undefined,
  mode: 'edit' | 'view' = 'edit',
): Promise<boolean> {
  const item = buildRoomInviteItem({
    shareCode,
    title: (() => {
      const live = sessionFor(ownerUid);
      return live ? sessionLabel(ownerUid, live.session) : sessionDocTitle(ownerUid);
    })(),
  });
  // Movable-format rooms carry the higher floor: a pre-movable build
  // joining one couldn't read its containers at all, so it must get
  // the decline-with-update-toast instead of a broken join. (The
  // invite's OWN session when known — a join-request approval can be
  // for a session other than the focused one.)
  const format = (sessionFor(ownerUid) ?? actionSession())?.session.childrenFormat() ?? 'list';
  const res = await pairingRelayClient.send(target.codes, item, {
    via: target.via,
    minReceiverVersion: roomInviteFloor(format, mode),
  });
  const verb = mode === 'view' ? 'Invited to watch' : 'Invited';
  if (res.fail === 0) showToast(`${verb} ${target.label} ✓`);
  else if (res.ok === 0) showToast(`Couldn't reach ${target.label}`);
  else showToast(`${verb} ${target.label} (${res.fail} failed)`);
  return res.ok > 0;
}

// ── Team sessions (relay extension; see team-sessions.ts) ──────────────

/** What a team-sessions call needs, or null when the feature is off here:
 *  desktop only, a team key from the team file, and a relay client. */
export function teamContext(): TeamContext | null {
  if (!getElectronHost() || !collabEnabled()) return null;
  const teamKey = settings.get('teamSessionsKey');
  if (!isTeamKey(teamKey)) return null;
  const client = relayClient();
  if (!client) return null;
  return { client, baseUrl: relayBaseUrl(), teamKey };
}

/** This machine's pairing code when it can receive an invite. */
export function ownPairingCode(): string {
  const code = normalizePairingCode(settings.get('pairingOwnCode'));
  return looksLikePairingCode(code) ? code : '';
}

/** List a just-started session for the team (best-effort, never blocks). */
export function listStartedSession(roomId: string, name: string, shareCode: string): void {
  const ctx = teamContext();
  if (!ctx) return;
  void listRoom(ctx, {
    roomId,
    name,
    startedBy: settings.get('pairingDisplayName'),
    mode: settings.get('teamSessionsOpen') ? 'open' : 'request',
    shareCode,
  });
}

/** Re-PUT a listing this machine made (a rename, a host resume), keeping
 *  the mode it was listed with. No-op for an unlisted room. */
export function relistSession(roomId: string, name: string, shareCode: string, people?: string[]): void {
  const mode = listedMode(roomId);
  const ctx = mode ? teamContext() : null;
  if (!ctx || !mode) return;
  void listRoom(ctx, { roomId, name, startedBy: settings.get('pairingDisplayName'), mode, shareCode, ...(people ? { people } : {}) });
}

/** Watch a live session's join requests and drive the approval prompt.
 *  Returns the stop function (a no-op stub when the feature is off). */
export function startTeamWatch(session: CollabSession, shareCode: string, ownerUid: string): () => void {
  // A spectator holds a view code only: it can't approve anyone into the room.
  if (session.role === 'spectator' || !teamContext()) return () => {};
  const roomId = session.roomId;
  // A resumed host refreshes its listing (name may have changed while
  // the app was closed). A fresh start lists after start() instead.
  if (session.role === 'host') relistSession(roomId, sessionLabel(ownerUid, session), shareCode);
  const handlers = {
    sessionName: () => sessionLabel(ownerUid, session),
    approve: async (req: PendingJoinRequest): Promise<void> => {
      const ctx = teamContext();
      if (!ctx) return;
      const res = await approveJoinRequest(ctx.client, req, (publicKey, name) =>
        sendInviteTo({ codes: [publicKey], label: name }, shareCode, ownerUid),
      );
      if (res === 'mismatch') {
        showToast(`Couldn\u2019t approve ${req.name}: their request is malformed. Ask them to request again.`);
        await denyJoinRequest(ctx.client, roomId, req.requestId);
      } else if (res === 'failed') {
        // sendInviteTo already toasted why; offer the request again.
        unhideJoinRequest(req.requestId);
      }
    },
    deny: async (req: PendingJoinRequest): Promise<void> => {
      const ctx = teamContext();
      if (ctx) await denyJoinRequest(ctx.client, roomId, req.requestId);
    },
  };
  const watcher = watchJoinRequests({
    roomId,
    role: session.role === 'host' ? 'host' : 'participant',
    context: teamContext,
    ownCode: ownPairingCode,
    onRequests: (reqs) => setJoinRequests(roomId, reqs, handlers),
  });
  // The host keeps its listing's "who's in it" current, so teammates see
  // who they'd be joining. Only on a change, checked every 20 s.
  let listedPeople = '';
  const peopleTimer =
    session.role === 'host'
      ? setInterval(() => {
          const names = (sessionFor(ownerUid)?.cursors.presence() ?? []).map((p) => p.name);
          const sig = names.join('\n');
          if (sig === listedPeople || !listedMode(roomId)) return;
          listedPeople = sig;
          relistSession(roomId, sessionLabel(ownerUid, session), shareCode, names);
        }, 20_000)
      : null;
  return () => {
    watcher.stop();
    if (peopleTimer) clearInterval(peopleTimer);
    clearJoinRequests(roomId);
  };
}

/** The Join dialog's Team sessions section, or undefined when the feature
 *  is off (then the dialog never shows it). */
export function teamJoinSource(): TeamSessionsSource | undefined {
  if (!teamContext()) return undefined;
  return {
    load: async () => {
      const ctx = teamContext();
      if (!ctx) return null;
      const rows = await loadTeamSessions(ctx);
      // A session already open in this window is not one to join.
      return rows ? rows.filter((r) => !roomLiveInWindow(r.roomId)) : null;
    },
    alreadyRequested,
    request: async (row) => {
      const ctx = teamContext();
      const code = ownPairingCode();
      if (!ctx) return { ok: false, message: 'Team sessions aren\u2019t available right now.' };
      if (!code || !settings.get('pairingEnabled')) {
        void offerSharingSetup('Asking to join a session');
        return { ok: false, message: 'Turn on card sharing first, so the invite can reach you.' };
      }
      const name = settings.get('pairingDisplayName').trim() || 'A teammate';
      const res = await requestToJoin(ctx, row.roomId, { name, publicCode: code });
      if (res === 'sent') return { ok: true, message: TEAM_REQUEST_SENT_MESSAGE };
      if (res === 'gone') return { ok: false, message: 'That session has ended or isn\u2019t listed anymore.' };
      return { ok: false, message: 'Couldn\u2019t send the request. Check your connection and try again.' };
    },
  };
}
