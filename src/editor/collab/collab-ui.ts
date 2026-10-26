/**
 * Collaboration-session UI flows: start / join / copy-code / end,
 * wired to the ribbon commands, plus the status-bar chip. Lazily
 * imported (this module pulls the Loro wasm via collab-session).
 *
 * One session per window at a time, bound to the single-doc view. The
 * flows own the editor's collab seams (collab-hooks): while a session
 * is live they register the plugin source (Loro sync + undo manager),
 * the transaction tagger (stamps sync-origin on the binding's remote
 * transactions so read mode and the AI coordinator admit them), and
 * refresh the plugin stack through the injected reconfigure capability.
 *
 * Invite transport: the share code (clipboard) and, on desktop, sealed
 * pairing-mailbox invites (inviteStarredFlow / joinSessionWithCode via
 * the Receive pill's Join).
 *
 * Team sessions (desktop, relay extension — team-sessions.ts): with a
 * team key and a relay that supports it, a started session is listed for
 * the team, Join session shows the team's listings, and a participant in
 * a listed session approves join requests by sending the invite card.
 */

import type { EditorView } from 'prosemirror-view';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { surfaceError } from '../error-surface.js';
import { offerSharingSetup } from '../pairing/sharing-setup.js';
import { promptForText, confirmDialog } from '../text-prompt.js';
import { setCollabCopresenceProvider, setCollabCloseActions, setCollabHandoffProvider, setCollabSessionCountProvider, setCollabLiveRoomProbe, setCollabFocusChangeHandler, setCollabShareCodeGetter, setCollabInviteLinkGetter } from './collab-hooks.js';
import { getElectronHost } from '../host/index.js';
import { ensureBakedRelay, relayClient, relayClientWithGuestPass, endRoomOnRelay } from './collab-relay.js';
import { teamSessionsSupportWithin } from './team-sessions.js';
import { buildJoinLink, parseJoinLinkHash } from './join-link.js';
import { resolveStarredTarget } from '../pairing/send-to-starred.js';
import { loadSessionRecord, loadPrefetch, deletePrefetch, deleteRecentRoom } from './collab-store.js';
import { loadRejoinCandidates, pickSessionToJoin } from './rejoin-picker.js';
import { importRoomKey, decryptBlob } from './collab-crypto.js';
import { collabEnabled } from './collab-gate.js';
import { decodeShareCode } from './collab-crypto.js';
import { CollabSession, JoinCancelledError, SessionStartCancelledError } from './collab-session.js';
import { joinWarning, MERGE_COPIES_LINK, shareWarning } from './large-doc.js';
import { compareAppVersions } from '../relay-protocol.js';
import { appVersion } from '../install-info.js';
import { currentRelayTag, partnersHere, relayLabelForTag, relayProfileIdForTag } from '../pairing/contact-relays.js';
import { type ActiveSession, type CollabUiDeps, META_COMMIT_ORIGIN, actionSession, chipSession, roomLiveElsewhere, roomLiveInWindow, sessionFor, sessions } from './collab-ui-state.js';
import { refreshChipForFocus, updateChip } from './collab-chip.js';
import { sessionPrepOverlay, sessionProgressOverlay } from './collab-overlays.js';
import { sessionCallbacks } from './collab-session-callbacks.js';
import { relayFailureMessage, resumeFailure, roomIsGone, roomsStatus, sessionRelayPlan } from './collab-session-policy.js';
import { installSeams, teardownFor } from './collab-seams.js';
import { META_TITLE_CUSTOM, adoptSharedTitle, defaultSessionName, namedDocTitle, sessionDocTitle, sharedDocTitle, titleIsCustom } from './collab-titles.js';
import { listStartedSession, relistSession, sendInviteTo, teamContext, teamJoinSource } from './collab-team-listing.js';
import { joinSessionWithCode, onSessionRelay } from './collab-join-flows.js';

// Moved to their own modules; re-exported so callers keep importing them from here.
export type { CollabUiDeps } from './collab-ui-state.js';
export { roomLiveInWindow, setCollabDocIdResolver, setCollabDocTitleResolver, setCollabFocusResolver } from './collab-ui-state.js';
export { refreshChipForFocus } from './collab-chip.js';
export { __setOfflineNoticeMsForTests } from './collab-session-callbacks.js';
export { relayFailureMessage } from './collab-session-policy.js';
export { defaultSessionName, namedDocTitle } from './collab-titles.js';
export { joinSessionWithCode, resumeSessionFlow } from './collab-join-flows.js';

// Feed the multi-pane shell's per-slot footers: each slot paints the copresence
// of ITS visible doc's session (or nothing when that doc isn't in a session).
setCollabCopresenceProvider((uid) => {
  const sess = sessionFor(uid);
  if (!sess) return null;
  return {
    role: sess.session.role,
    // Before the first onStatus, assume connected (start() flushes immediately);
    // the flows also stamp lastStatus so an offline join/resume reads correctly.
    connected: sess.lastStatus?.connected ?? true,
    queued: sess.lastStatus?.queuedUpdates ?? 0,
    offlineSince: sess.offlineSince,
    reconnect: () => sess.session.restart(),
    peers: sess.cursors.presence().map((p) => ({ name: p.name, color: p.color, self: p.self, code: p.code })),
  };
});

// Close-time actions for a co-edited doc, called by the always-loaded close
// paths (multi-pane shell + single-doc) via collab-hooks. Registered once here.
setCollabCloseActions({
  keepResumable: (uid) => closeKeepResumableSession(uid),
  endOrLeave: (uid) => closeEndOrLeaveSession(uid),
});

// Mode-switch hand-off: flush every live session's record (so unsynced edits
// survive the toggle's reload) and report {uid, roomId} so the post-reload flow
// can auto-resume each into the doc that reopens under its uid.
setCollabHandoffProvider(async () => {
  const list = [...sessions.values()].map((s) => ({ uid: s.ownerUid, roomId: s.session.roomId }));
  // The record AND the history file: history's only other reload hook is
  // the fire-and-forget pagehide write, which a fast teardown cuts off
  // mid-write — the same reason persist is flushed here (2026-09-01
  // review, PH-A5).
  await Promise.all(
    [...sessions.values()].flatMap((s) => [s.persist.flush(), s.history.flush()]),
  );
  return list;
});
setCollabSessionCountProvider(() => sessions.size);
setCollabLiveRoomProbe((roomId) =>
  [...sessions.values()].some((s) => s.session.roomId === roomId),
);
setCollabFocusChangeHandler(() => refreshChipForFocus());

// The Send pill's session action ("Start session" vs "Copy session
// code") keys off the FOCUSED doc's live session — an action, so it
// uses actionSession(), never the display fallback (see above).
setCollabShareCodeGetter(() => actionSession()?.shareCode ?? null);
setCollabInviteLinkGetter(() => {
  const s = actionSession();
  if (!s) return null;
  return buildJoinLink({ shareCode: s.shareCode, guestPass: s.session.guestPass });
});

/** Start-session gate: a session is started FOR a focused document, so a
 *  live view is required (join/resume create their own doc and do not use
 *  this). The message holds in both modes — single-pane always has a doc;
 *  multi-pane hits this only with every slot empty/unfocused. */
function guardReady(deps: CollabUiDeps): EditorView | null {
  if (!collabEnabled()) return null;
  const view = deps.getView();
  if (!view) {
    showToast('Open and focus a document to start a co-editing session');
    return null;
  }
  return view;
}

/** Docs with a Start flow mid-confirm/mid-relay: a double-click (or a second
 *  Start command racing the first's awaits) minted TWO rooms for one doc
 *  (audit find, 2026-07-10). */
const startsInFlight = new Set<string>();

export async function startSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return; // desktop-only; inert on the web edition
  const view = guardReady(deps);
  if (!view) return;
  const ownerUid = deps.getOwnerUid?.() ?? '';
  if (sessionFor(ownerUid)) {
    showToast('This document already has a session — end or leave it first');
    return;
  }
  if (startsInFlight.has(ownerUid)) {
    showToast('Starting the session — one moment');
    return;
  }
  startsInFlight.add(ownerUid);
  try {
    await startSessionFlowInner(deps, view, ownerUid);
  } finally {
    startsInFlight.delete(ownerUid);
  }
}

async function startSessionFlowInner(
  deps: CollabUiDeps,
  view: EditorView,
  ownerUid: string,
): Promise<void> {
  // Not set up to share yet: offer setup BEFORE the start confirm (it
  // used to confirm first, then toast "No relay connection").
  await ensureBakedRelay();
  if (!relayClient()) {
    void offerSharingSetup('Starting a co-editing session');
    return;
  }
  const startName = sessionDocTitle(ownerUid);
  // Large documents get the cost spelled out first (see large-doc.ts for
  // what grows with size).
  const sizeWarning = shareWarning(view.state.doc);
  if (sizeWarning) {
    const ok = await confirmDialog(sizeWarning, {
      title: `Start a co-editing session for ${startName ? `"${startName}"` : 'this document'}?`,
      okLabel: 'Start Anyway',
      link: MERGE_COPIES_LINK,
    });
    if (!ok) return;
  }
  // Name the session: it's what everyone sees in their Sessions list and
  // what joiners' copies are called. Pre-filled with "Filename - Display
  // Name"; cleared, the same default (never "Untitled").
  const docName = namedDocTitle(startName);
  const fallbackName = defaultSessionName(docName, settings.get('pairingDisplayName'));
  // Team sessions: offer the per-session opt-out only when this session
  // would be listed (team key + a relay that answers discovery quickly).
  const teamCtx = teamContext();
  const teamListable = !!teamCtx && !!(await teamSessionsSupportWithin(teamCtx, 3000));
  let dontList = false;
  const typed = await promptForText({
    message: 'Start a co-editing session',
    detail:
      'Anyone you share the code with can edit this document with you in real time. ' +
      'Name the session — it\u2019s what everyone sees in their Sessions list.',
    initial: fallbackName,
    placeholder: fallbackName,
    okLabel: 'Start Session',
    ...(teamListable
      ? {
          checkbox: {
            label: 'Don\u2019t list this session for my team',
            checked: false,
            onChange: (v: boolean) => {
              dontList = v;
            },
          },
        }
      : {}),
  });
  if (typed === null) return;
  const sessionName = typed.trim() || fallbackName;
  // A name the host typed sticks: saving or renaming the document no
  // longer republishes over it. Kept as the default, it follows the
  // document's name (see republishSessionTitle).
  const customName = sessionName !== fallbackName;
  await ensureBakedRelay();
  const client = relayClient();
  if (!client) {
    void offerSharingSetup('Starting a co-editing session');
    return;
  }
  try {
    // Host on the CURRENT (focused) doc — no doc swap, so its uid is the owner.
    let sessRef: ActiveSession | null = null;
    // host() seeds the ENTIRE doc into the CRDT synchronously, and the
    // binding's init (a setTimeout(0) inside the sync plugin) then does
    // its own synchronous pass — the veil must outlive BOTH, or it
    // vanishes while the editor is still frozen (field find, 2026-08-12
    // three-pane test). The finally releases it via setTimeout(0).
    const controller = new AbortController();
    const progressUi = await sessionProgressOverlay(() => controller.abort());
    const prepDone = progressUi.close;
    let session: CollabSession;
    let shareCode: string;
    let sess: ActiveSession;
    try {
      ({ session, shareCode } = await CollabSession.host({
        pmDoc: view.state.doc,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
        onProgress: (p) => progressUi.update(p),
        signal: controller.signal,
      }));
      progressUi.lockCancel();
      // ownerUid captured at flow start (line ~427), under the doc that was
      // focused when Start was chosen — host() shared THAT doc's content, so
      // the seams must bind to it even if focus has since moved.
      sess = installSeams(session, deps, shareCode, ownerUid);
      sessRef = sess;
      // Seed before start(): the first flush then carries the host's
      // existing comment threads alongside the seeded doc — and the doc
      // title, so joiners can name their unsaved copy.
      sess.commentsSync.seedFromView(view);
      session.loroDoc.getMap('meta').set('title', sessionName);
      if (customName) session.loroDoc.getMap('meta').set(META_TITLE_CUSTOM, true);
      session.loroDoc.commit({ origin: META_COMMIT_ORIGIN });
      deps.refreshPlugins();
      session.start();
    } finally {
      // The binding queued its init (the second synchronous freeze) via
      // setTimeout(0) inside refreshPlugins; same-delay timeouts run
      // FIFO, so queueing the veil's removal NOW runs it right after
      // that init finishes — without inserting awaits into this flow,
      // which lets live session callbacks interleave mid-flow (broke
      // the flow tests when tried).
      setTimeout(prepDone, 0);
    }
    sess.lastStatus = { connected: true, queuedUpdates: 0 };
    updateChip({ connected: true, queuedUpdates: 0 });
    if (teamListable && !dontList) listStartedSession(session.roomId, sessionName, shareCode);
    // Web hosts copy the INVITE LINK (their partner most likely joins in
    // a browser; the link carries the guest pass so an account-less
    // joiner works). Desktop keeps the bare code — its partners are
    // other installs, and the code paste-flow is muscle memory there.
    const inviteText = getElectronHost()
      ? shareCode
      : buildJoinLink({ shareCode, guestPass: session.guestPass });
    const copied = await navigator.clipboard?.writeText(inviteText).then(
      () => true,
      () => false,
    );
    showToast(
      copied
        ? getElectronHost()
          ? 'Session started — session code copied, send it to your partner'
          : 'Session started — invite link copied, send it to your partner'
        : 'Session started — use "Copy Session Code" to invite',
    );
  } catch (err) {
    if (err instanceof SessionStartCancelledError) {
      showToast('Session not started');
      return;
    }
    showToast(relayFailureMessage(err, { initiating: true, verb: 'start the session' }));
  }
}

export async function joinSessionFlow(deps: CollabUiDeps): Promise<void> {
  if (!collabEnabled()) return;
  // Sessions this user can get back into (saved copies, rooms they left)
  // are listed under the paste box.
  const listed = await loadRejoinCandidates(roomLiveInWindow);
  // A room live in ANOTHER window is not something to rejoin from here: in
  // the single-window shell picking it spawned a window first, whose resume
  // then refused the room and left that window empty.
  const elsewhere = await Promise.all(listed.map((c) => roomLiveElsewhere(c.roomId)));
  const candidates = listed.filter((_, i) => !elsewhere[i]);
  // One dialog: the paste box on top (focused — a new join is paste and
  // Enter), the sessions to get back into below it.
  const pick = await pickSessionToJoin(candidates, teamJoinSource());
  if (!pick) return;
  if (pick.kind === 'rejoin') {
    if (!(await onSessionRelay(pick.relay))) return;
    await joinSessionWithCode(deps, pick.shareCode, { guestPass: pick.guestPass });
    return;
  }
  const entered = pick.text;
  // A team relay invite link (https://…/relay/join#… or xtgg-relay://join?…)
  // pasted here: connect to the relay instead of joining a session.
  const { joinRelayFromText } = await import('../pairing/relay-join.js');
  if (await joinRelayFromText(entered)) return;
  // A full invite link pastes here too (the Chromebook path: link
  // received in a chat, app already open). Extract code + guest pass.
  const hashIdx = entered.indexOf('#');
  const fromLink = hashIdx >= 0 ? parseJoinLinkHash(entered.slice(hashIdx)) : null;
  if (fromLink) {
    await joinSessionWithCode(deps, fromLink.shareCode, { guestPass: fromLink.guestPass });
    return;
  }
  await joinSessionWithCode(deps, entered);
}

export async function copyInviteLinkFlow(): Promise<void> {
  const sess = actionSession();
  if (!sess) {
    showToast('This document has no active session');
    return;
  }
  const link = buildJoinLink({
    shareCode: sess.shareCode,
    guestPass: sess.session.guestPass,
  });
  const ok = await navigator.clipboard?.writeText(link).then(
    () => true,
    () => false,
  );
  showToast(ok ? 'Invite link copied' : 'Could not copy the invite link');
}

export async function copyShareCodeFlow(): Promise<void> {
  const sess = actionSession();
  if (!sess) {
    showToast('This document has no active session');
    return;
  }
  const ok = await navigator.clipboard?.writeText(sess.shareCode).then(
    () => true,
    () => false,
  );
  showToast(ok ? 'Session code copied' : 'Could not copy the session code');
}

/** Re-publish the owner doc's display name to its live session's meta
 *  map. Host-only (the shared title tracks the HOST's file; a joiner's
 *  local Save-As must not rename the session for everyone), and a
 *  no-op without a session for `uid`, without a resolvable name, or
 *  when the name is unchanged. The shells call this whenever a doc's
 *  filename commits (Save / Save-As), so a session started on an
 *  untitled doc gets its name the moment the host saves — and every
 *  joiner's meta subscription adopts it live. */
export function republishSessionTitle(uid: string | null): void {
  if (!uid) return;
  const sess = sessions.get(uid);
  if (!sess || sess.session.role !== 'host') return;
  if (titleIsCustom(sess.session)) return; // the host named it: keep that
  // Default naming ("Filename - Display Name"), once the document has a
  // real name — an unsaved doc keeps its dated default.
  const docName = namedDocTitle(sessionDocTitle(uid));
  if (!docName) return;
  const name = defaultSessionName(docName, settings.get('pairingDisplayName'));
  if (name === sharedDocTitle(sess.session)) return;
  sess.session.loroDoc.getMap('meta').set('title', name);
  sess.session.loroDoc.commit({ origin: META_COMMIT_ORIGIN });
  relistSession(sess.session.roomId, name, sess.shareCode);
}

/** Send a session invite to the starred partner/group. */
export async function inviteStarredFlow(): Promise<void> {
  if (!collabEnabled()) return;
  const sess = actionSession();
  if (!sess) {
    showToast('This document has no active session — start one first');
    return;
  }
  if (!settings.get('pairingEnabled')) {
    void offerSharingSetup('Inviting someone');
    return;
  }
  const target = resolveStarredTarget(
    settings.get('pairingStarred'),
    partnersHere(),
    settings.get('pairingGroups'),
  );
  if (!target) {
    showToast(
      settings.get('pairingStarred')
        ? 'Your starred contact isn’t on this relay. Switch relays, or star someone here.'
        : 'Star a partner or group in the Send pill first',
    );
    return;
  }
  if (target.codes.length === 0) {
    showToast('The starred group has no recipients yet');
    return;
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** The Send pill's click-to-invite (§6 picker-first flow): with no
 *  active session, START one on the current doc, then invite the
 *  picked partner/group; with one active, just invite. */
export async function inviteTargetFlow(
  deps: CollabUiDeps,
  target: { codes: string[]; label: string; via?: string },
): Promise<void> {
  if (!collabEnabled()) return;
  if (!settings.get('pairingEnabled')) {
    void offerSharingSetup('Inviting someone');
    return;
  }
  if (target.codes.length === 0) {
    showToast('That group has no recipients yet');
    return;
  }
  let sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    await startSessionFlow(deps);
    sess = sessionFor(deps.getOwnerUid?.());
    if (!sess) return; // start failed/cancelled — its toast explains
  }
  await sendInviteTo(target, sess.shareCode, sess.ownerUid);
}

/** Terminate/leave a session and clear its resumable record — the shared core
 *  of the explicit End command and the close dialog's End/Leave choice (no
 *  prompt; the caller already confirmed). Host ends for everyone (tombstones the
 *  room); a participant just disconnects. */
/** End (host) or leave (guest) a session. Returns false when a host End
 *  couldn't tombstone the room (offline / filtered network) — the session is
 *  left LIVE and nothing is torn down, so the caller must abort whatever
 *  close it was driving. Reporting success without the tombstone let invited
 *  peers keep editing a room the host believed was over, with the local
 *  record (the host's only handle for ending it) already deleted (audit +
 *  field find, 2026-07-10). A guest Leave has no server side and always
 *  succeeds. */
async function endOrLeaveSession(sess: ActiveSession): Promise<boolean> {
  const isHost = sess.session.role === 'host';
  // Disconnect first (final drain attempt), THEN tombstone for a host end —
  // and only tear down once the room is actually gone. endRoomOnRelay treats
  // an already-ended/expired room (410/404) as success.
  sess.cursors.farewell(); // announce departure while the stream is still up
  await sess.session.stop();
  if (isHost) {
    try {
      await endRoomOnRelay(sess.session.roomId);
    } catch (err) {
      // Reconnect and keep the session (and its record) intact — the user
      // retries once the relay is reachable.
      sess.session.start();
      console.warn('[collab] could not end the session:', err);
      showToast('Couldn’t end the session — check your connection and try again.');
      return false;
    }
  }
  // Registry drop before the record delete, so a late stream frame's
  // onEnded no-ops.
  // A host End tombstoned the room; a guest Leave leaves it alive and
  // rejoinable from Join session.
  const cleared = teardownFor(sess, isHost ? 'host-end' : 'guest-leave');
  refreshChipForFocus(); // repaint from live truth (a stale snapshot left ghost chips — field find, 2026-08-12)
  await cleared; // record actually gone before we return
  return true;
}

/** Close a co-edited doc but KEEP its session resumable: disconnect (a final
 *  drain attempt), persist the CRDT — including edits that never reached the
 *  relay — then drop the live binding while leaving the stored record behind.
 *  The home-screen Sessions list resumes it; unsynced edits flush on rejoin.
 *  Called from the always-loaded close paths via collab-hooks. */
async function closeKeepResumableSession(uid: string): Promise<boolean> {
  const sess = sessionFor(uid);
  if (!sess) return true;
  await sess.session.stop(); // disconnect only — the room + record survive
  // Capture the final state (incl. any still-unsynced edits) AFTER the drain so
  // sentVersion is accurate — VERIFIED: the close path drops the recovery
  // journal, so this record is about to be the doc's only copy. A silent
  // storage failure must abort the close, not lose the doc (audit find,
  // 2026-07-10).
  if (!(await sess.persist.verifiedFlush())) {
    sess.session.start(); // reconnect; the session stays live, caller aborts
    return false;
  }
  void teardownFor(sess, 'keep-resumable').catch((e) => surfaceError('collab teardown', e));
  refreshChipForFocus(); // repaint from live truth (a stale snapshot left ghost chips — field find, 2026-08-12)
  return true;
}

/** Relay switch: leave every live session in this window, keeping each one
 *  resumable (the room stays on its relay; the doc stays open as this
 *  copy). Same steps as closing a doc but keeping its session, plus the
 *  owner's plugin rebuild. False = a record couldn't be verified; that
 *  session (and any not reached yet) stays live. */
export async function leaveAllSessionsForRelaySwitch(deps: CollabUiDeps): Promise<boolean> {
  for (const sess of [...sessions.values()]) {
    if (!(await closeKeepResumableSession(sess.ownerUid))) return false;
    if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
    else deps.refreshPlugins();
  }
  return true;
}

/** Close a co-edited doc by ending/leaving its session (clears the record).
 *  False = a host End failed to tombstone; nothing was torn down. */
async function closeEndOrLeaveSession(uid: string): Promise<boolean> {
  const sess = sessionFor(uid);
  if (!sess) return true;
  return endOrLeaveSession(sess);
}

export async function endSessionFlow(deps: CollabUiDeps): Promise<void> {
  // Ends the FOCUSED doc's session (the one the user is looking at).
  const sess = sessionFor(deps.getOwnerUid?.());
  if (!sess) {
    showToast('No active session');
    return;
  }
  const isHost = sess.session.role === 'host';
  // In-app overlay, NOT window.confirm: Electron's native confirm on
  // Windows/Linux never hands keyboard focus back to the renderer —
  // the editor was untypeable until a reload (field bug, 2026-07-03).
  const choice = await confirmDialog(
    isHost ? 'Participants keep their current copy.' : 'Your copy stays as it is now.',
    {
      title: isHost ? 'End the session for everyone?' : 'Leave the session?',
      okLabel: isHost ? 'End Session' : 'Leave Session',
    },
  );
  if (!choice) return;
  // A failed host End (relay unreachable) already toasted and left the
  // session live — don't repaint plugins or claim success.
  if (!(await endOrLeaveSession(sess))) return;
  if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
  else deps.refreshPlugins();
  showToast(isHost ? 'Session ended' : 'Left the session');
  deps.getView()?.focus();
}

/** Test seam: the session the user is looking at (focused doc's, or the sole
 *  session), or null. */
export function activeSession(): CollabSession | null {
  return chipSession()?.session ?? null;
}

/** Recover Previous Version command body. Lives here (not in the
 *  recover module) so the lazy-loaded collab-ui module is the single
 *  entry point index.ts's command wiring already uses, and so the
 *  recover module needs no import back into this one. */
export async function recoverPreviousVersionFlow(
  openDoc?: import('./collab-recover-ui.js').OpenRecoveredDoc,
  solo?: {
    docId: string | null;
    docTitle: string;
    currentDoc?: import('prosemirror-model').Node | null;
  },
): Promise<void> {
  const m = await import('./collab-recover-ui.js');
  await m.openRecoverPreviousVersion(activeSession(), openDoc, solo);
}
