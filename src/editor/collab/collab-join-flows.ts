/**
 * Joining a session with a code and resuming a saved one, plus the
 * switch-to-its-relay-first check both use. Split out of collab-ui.ts, which
 * re-exports the public flows.
 */

import { showToast } from '../toast.js';
import { surfaceError } from '../error-surface.js';
import { offerSharingSetup } from '../pairing/sharing-setup.js';
import { confirmDialog } from '../text-prompt.js';
import { ensureBakedRelay, relayClient, relayClientWithGuestPass, relayClientWithViewPass } from './collab-relay.js';
import type { RoomsClient } from './room-client.js';
import { loadSessionRecord, loadPrefetch, deletePrefetch, deleteRecentRoom } from './collab-store.js';
import { importRoomKey, decryptBlob } from './collab-crypto.js';
import { collabEnabled } from './collab-gate.js';
import { decodeShareCode } from './collab-crypto.js';
import { CollabSession, JoinCancelledError } from './collab-session.js';
import { joinWarning, MERGE_COPIES_LINK } from './large-doc.js';
import { compareAppVersions } from '../relay-protocol.js';
import { appVersion } from '../install-info.js';
import { currentRelayTag, relayLabelForTag, relayProfileIdForTag } from '../pairing/contact-relays.js';
import { type ActiveSession, type CollabUiDeps, roomLiveElsewhere, sessionFor, sessions } from './collab-ui-state.js';
import { updateChip } from './collab-chip.js';
import { sessionPrepOverlay } from './collab-overlays.js';
import { sessionCallbacks } from './collab-session-callbacks.js';
import { relayFailureMessage, resumeFailure, roomIsGone, roomsStatus, sessionRelayPlan } from './collab-session-policy.js';
import { installSeams, teardownFor } from './collab-seams.js';
import { adoptSharedTitle } from './collab-titles.js';

/** A session lives on one relay: switch to it first when it's elsewhere.
 *  False when it can't be (not saved here, or the user said no). Untagged
 *  sessions (older records) go to the relay in use, as before. */
export async function onSessionRelay(tag: string | null | undefined): Promise<boolean> {
  const plan = sessionRelayPlan(tag, currentRelayTag(), relayProfileIdForTag);
  if (plan.kind === 'here') return true;
  if (plan.kind === 'not-saved') {
    showToast(`That session is on ${relayLabelForTag(tag ?? '')}, which isn’t saved here. Connect to it in Settings → Collaboration first.`);
    return false;
  }
  const { switchRelayNow } = await import('./relay-profiles-ui.js');
  return (await switchRelayNow(plan.profileId)) === 'switched';
}

export const joinsInFlight = new Set<string>();
export const resumesInFlight = new Set<string>();

/** Join with a code in hand — the prompt flow above and the Receive
 *  pill's invite Join both land here. Returns true when the join actually
 *  landed (or was handed to a spawned window) — the Receive pill consumes
 *  the invite only then, so a cancelled slot pick or an unreachable relay
 *  doesn't burn the share code. No view is required up front: the flow
 *  creates its own doc via deps.newSessionDoc (multi-pane may be an empty
 *  workspace at this point). */
export async function joinSessionWithCode(
  deps: CollabUiDeps,
  code: string,
  opts?: { guestPass?: string | null },
): Promise<boolean> {
  const roomId = decodeShareCode(code.trim())?.roomId ?? null;
  if (roomId && joinsInFlight.has(roomId)) return true; // already joining — consumed
  if (roomId) joinsInFlight.add(roomId);
  try {
    return await joinSessionWithCodeInner(deps, code, opts);
  } finally {
    if (roomId) joinsInFlight.delete(roomId);
  }
}

export async function joinSessionWithCodeInner(
  deps: CollabUiDeps,
  code: string,
  opts?: { guestPass?: string | null },
): Promise<boolean> {
  if (!collabEnabled()) return false;
  // Don't overwrite the doc you're working in — or bump the session you're
  // already in: unless this window holds the disposable starter, hand the
  // join to a fresh window (which re-enters here with the starter open, so it
  // joins in place). Runs BEFORE the `active` guard and the session creation,
  // so an active-session window opens the new join elsewhere instead of
  // refusing, and the session + binding are born in the window that keeps them.
  // (Single-pane desktop only; the multi-pane deps have no spawnJoinWindow.)
  // Counts as consumed: the join continues in the spawned window.
  if (deps.spawnJoinWindow?.(code.trim())) return true;
  // Don't overwrite a doc that's ITSELF in a session (spawnJoinWindow already
  // redirected windows holding a real doc; this guards the edge case).
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it before joining here');
    return false;
  }
  await ensureBakedRelay();
  const decoded = decodeShareCode(code);
  if (!decoded) {
    showToast('That does not look like a session code or invite link');
    return false;
  }
  let client: RoomsClient | null;
  if (decoded.view) {
    // SPECTATOR join: authenticate with the room's view pass and NOTHING
    // else — own credentials would be an editor seat, and the relay
    // enforces view-only per credential. A view link carries the pass;
    // a pasted view code gets one minted with whatever credentials this
    // install has (the relay mints view passes for any room credential).
    let pass = opts?.guestPass ?? null;
    if (!pass) pass = (await relayClient()?.fetchViewPass(decoded.roomId)) ?? null;
    client = pass ? relayClientWithViewPass(pass) : null;
    if (!client) {
      if (relayClient()) showToast('Could not get a viewer pass for this session — ask for a fresh view link');
      else void offerSharingSetup('Watching a co-editing session');
      return false;
    }
  } else {
    // Own credentials (baked token / linked account / self-host settings)
    // outrank a guest pass — they're strictly more capable. The pass is
    // the fallback that lets an account-less browser join at all.
    client = relayClient() ?? (opts?.guestPass ? relayClientWithGuestPass(opts.guestPass) : null);
    if (!client) {
      void offerSharingSetup('Joining a co-editing session');
      return false;
    }
  }
  // v2 codes carry the room's compatibility floor. (Old builds never
  // get this far — the v2 format fails their parser above — this check
  // is for FUTURE floors above the running version.)
  if (decoded.minVersion && compareAppVersions(appVersion, decoded.minVersion) < 0) {
    showToast(
      `This session needs CardMirror ${decoded.minVersion} or newer — update to join.`,
    );
    return false;
  }
  // A resumable record for this room means WE'VE been in it before — resume
  // instead of fresh-joining, so the record's unsynced local edits flush to
  // the room. A fresh join minted a second copy from the relay state, and a
  // later Leave deleted the old record, making those edits unrecoverable
  // (audit find, 2026-07-10).
  // …but only a record of the SAME kind: an edit code never resumes into
  // a view-only record (that would silently keep the user a spectator), and
  // a view code never resumes an editor record (whose seat may be the one
  // that is full). The mismatched record is superseded by the new
  // session's own persistence.
  const prior = await loadSessionRecord(decoded.roomId);
  if (prior && (prior.role === 'spectator') === decoded.view) {
    return resumeSessionFlow(deps, decoded.roomId);
  }
  // Resolved after newSessionDoc/installSeams; callbacks read it lazily.
  let sessRef: ActiveSession | null = null;
  try {
    let session: CollabSession;
    let joinedOffline = false;
    try {
      session = await CollabSession.join({
        roomId: decoded.roomId,
        keyBytes: decoded.keyBytes,
        role: decoded.view ? 'spectator' : 'participant',
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
        // Asked after the download, before the (synchronous, possibly
        // minute-long) import.
        confirmLargeJoin: async (bytes) => {
          const warning = joinWarning(bytes);
          if (!warning) return true;
          return confirmDialog(warning, {
            title: 'Join a large shared document?',
            okLabel: 'Join Anyway',
            link: MERGE_COPIES_LINK,
          });
        },
      });
      // A spectator's bearer IS the view pass: persisted as the session's
      // credential (resume authenticates the same way) and as its view
      // pass (so it can hand out view links too).
      session.guestPass = decoded.view ? client.opts.token() : opts?.guestPass ?? null;
      if (decoded.view) session.viewPass = client.opts.token();
    } catch (err) {
      // An ENDED (410) or expired/GC'd (404) room is not an offline
      // condition — the seed would resume a session that no longer exists.
      // Surface it as ended.
      if (roomIsGone(roomsStatus(err))) throw err;
      if (err instanceof JoinCancelledError) throw err;
      // Offline (or relay unreachable): fall back to the invite's
      // prefetched seed (§4.1). Everything in it came FROM the room,
      // so resume() with no sentVersion is exact; start() syncs at the
      // next connectivity window.
      const pre = await loadPrefetch(decoded.roomId);
      if (!pre) throw err;
      const key = await importRoomKey(decoded.keyBytes);
      const blobs = await Promise.all(pre.blobs.map((b) => decryptBlob(key, b)));
      session = await CollabSession.resume({
        roomId: decoded.roomId,
        keyBytes: decoded.keyBytes,
        role: decoded.view ? 'spectator' : 'participant',
        snapshot: blobs[0]!,
        increments: blobs.slice(1),
        lastSeq: pre.lastSeq,
        client,
        callbacks: sessionCallbacks(deps, () => sessRef),
      });
      joinedOffline = true;
    }
    // Create the fresh unsaved session doc — its uid is the session owner
    // (single-pane swaps this window's doc; multi-pane slot-picks). A false
    // return = the user balked (overwrite prompt / slot picker) — unwind
    // without touching the room AND keep the prefetched seed: the invite
    // stays retryable.
    if (!(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Join cancelled');
      return false;
    }
    // The session owner is the doc newSessionDoc() just created — capture its
    // uid NOW, before any later focus change, so the seams bind into it.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, code.trim(), ownerUid);
    // Add the binding to the fresh doc's view — its init replaces the
    // empty content with the session's CRDT state synchronously (~10s
    // on a tournament-master-sized doc), but only after a setTimeout(0)
    // deferral inside the sync plugin: the veil's removal is queued
    // BEHIND that init (FIFO), or it vanishes before the freeze starts.
    const prepDone = await sessionPrepOverlay(
      'Opening the shared document — a large document can take a moment…',
    );
    try {
      deps.refreshPlugins();
      // The join snapshot already carries the host's thread map — land it
      // in the fresh pane's plugin state; same for the published title.
      sessRef.commentsSync.pull();
      adoptSharedTitle(deps, session);
      session.start();
    } finally {
      // FIFO with the binding's own setTimeout(0) init — see the host
      // flow's finally for why this is a timeout, not an await.
      setTimeout(prepDone, 0);
    }
    sessRef.lastStatus = { connected: !joinedOffline, queuedUpdates: 0 };
    updateChip({ connected: !joinedOffline, queuedUpdates: 0 });
    // Only NOW is the seed spent — the join is committed (for the offline
    // path the seed's content lives on in the session + its persist record).
    void deletePrefetch(decoded.roomId).catch((e) => surfaceError('collab seed cleanup', e));
    showToast(
      decoded.view
        ? joinedOffline
          ? 'Watching from the prefetched copy — will catch up when you reconnect'
          : 'Watching the session — you see every edit live; editing here is off'
        : joinedOffline
          ? 'Joined from the prefetched copy — will sync when you reconnect'
          : 'Joined the session',
    );
    deps.getView()?.focus();
    return true;
  } catch (err) {
    if (sessRef) void teardownFor(sessRef, 'join-failed').catch((e) => surfaceError('collab teardown', e));
    if (err instanceof JoinCancelledError) {
      showToast('Join cancelled');
      return false;
    }
    // A dead room's invite and seed are useless — purge the seed and report
    // consumed so the Receive pill clears the row. Every other failure keeps
    // both, so the user can retry once the network/slot situation changes.
    const ended = roomIsGone(roomsStatus(err));
    if (ended) {
      void deletePrefetch(decoded.roomId).catch((e) => surfaceError('collab seed cleanup', e));
      void deleteRecentRoom(decoded.roomId).catch((e) => surfaceError('collab recent rooms', e));
    }
    showToast(relayFailureMessage(err, { initiating: false, verb: 'join' }));
    return ended;
  }
}

/** Resume a persisted session (home-screen Sessions list, M3). The
 *  persisted CRDT carries this peer's full history — including edits
 *  that never reached the relay before the app died — so start()'s
 *  first flush sends exactly the unsent diff and catch-up resumes from
 *  the stored cursor. A tombstoned room degrades through the normal
 *  onEnded path ("this copy is now yours alone") and clears the record.
 *  Returns true when the session is live in this window afterwards (also
 *  when it already was) — joinSessionWithCode delegates here for rooms
 *  with a resumable record, and the Receive pill consumes the invite on
 *  true. */
export async function resumeSessionFlow(
  deps: CollabUiDeps,
  roomId: string,
  opts?: { existingDoc?: boolean },
): Promise<boolean> {
  if (resumesInFlight.has(roomId)) return true; // already resuming — consumed
  resumesInFlight.add(roomId);
  try {
    return await resumeSessionFlowInner(deps, roomId, opts);
  } finally {
    resumesInFlight.delete(roomId);
  }
}

export async function resumeSessionFlowInner(
  deps: CollabUiDeps,
  roomId: string,
  opts?: { existingDoc?: boolean },
): Promise<boolean> {
  if (!collabEnabled()) return false; // desktop-only; inert on the web edition
  // No up-front view requirement: unless resuming into an existing doc, the
  // flow creates its own via deps.newSessionDoc (multi-pane may be an empty
  // workspace reached from the home screen's Sessions list).
  if (opts?.existingDoc && !deps.getView()) return false;
  if (sessionFor(deps.getOwnerUid?.())) {
    showToast('This document is in a session — end or leave it first');
    return false;
  }
  for (const s of sessions.values()) {
    if (s.session.roomId === roomId) {
      showToast('That session is already active in this window');
      // Already live here — an invite for it is redundant, so report success.
      return true;
    }
  }
  // Cross-WINDOW guard: another window holding this room live claims its
  // synthetic key in the duplicate-open registry; probing it also focuses
  // that window (so the user lands on the live session, not an error).
  if (await roomLiveElsewhere(roomId)) {
    showToast('That session is already open in another CardMirror window.');
    return true; // live elsewhere — an invite/row for it is redundant here
  }
  const record = await loadSessionRecord(roomId);
  if (!record) {
    showToast('No saved session to resume');
    return false;
  }
  // Opened from a file or the Sessions list while on another relay: there
  // the room is unknown (404) and would read as ended, deleting the record.
  if (!(await onSessionRelay(record.relay))) return false;
  await ensureBakedRelay();
  // A spectator record resumes with its view pass ONLY (see the join flow);
  // everyone else prefers their own credentials.
  const client =
    record.role === 'spectator'
      ? record.guestPass
        ? relayClientWithViewPass(record.guestPass)
        : null
      : relayClient() ?? (record.guestPass ? relayClientWithGuestPass(record.guestPass) : null);
  if (!client) {
    if (record.role === 'spectator') showToast('This watched session has no viewer pass saved — ask for a fresh view link');
    else void offerSharingSetup('Rejoining a co-editing session');
    return false;
  }
  const decoded = decodeShareCode(record.shareCode);
  if (!decoded) {
    showToast('Saved session record is unreadable');
    return false;
  }
  let sessRef: ActiveSession | null = null;
  try {
    const session = await CollabSession.resume({
      roomId: record.roomId,
      keyBytes: decoded.keyBytes,
      role: record.role,
      snapshot: record.snapshot,
      increments: record.increments,
      lastSeq: record.lastSeq,
      sentVersion: record.sentVersion,
      client,
      callbacks: sessionCallbacks(deps, () => sessRef),
    });
    session.guestPass = record.guestPass ?? null;
    if (record.role === 'spectator') session.viewPass = record.guestPass ?? null;
    // Host resume without a stored pass: re-mint so fresh invite links
    // stay possible (no-op 404 while the relay flip is off, and guests
    // never pass the send-auth gate on this endpoint).
    if (record.role === 'host' && !session.guestPass) {
      void client.fetchGuestPass(record.roomId).then((p) => {
        if (p) session.guestPass = p;
      });
    }
    // Fresh doc first — its uid owns the session. A false return keeps the
    // record (still resumable) — no seams installed yet, so nothing to unwind.
    // EXCEPT `existingDoc`: bind into an ALREADY-open doc under its uid instead
    // of creating one (the binding replaces its content with the CRDT's —
    // same doc). A capability for resuming in place; no caller today.
    if (!opts?.existingDoc && !(await deps.newSessionDoc())) {
      await session.stop();
      showToast('Resume cancelled');
      return false;
    }
    // Owner = the doc that will hold the session: for existingDoc it is the
    // already-open doc under its uid; otherwise the fresh doc newSessionDoc()
    // just made (single-pane swap, or multi-pane slot). Capture past the awaits.
    const ownerUid = deps.getOwnerUid?.() ?? '';
    sessRef = installSeams(session, deps, record.shareCode, ownerUid);
    deps.refreshPlugins();
    sessRef.commentsSync.pull();
    adoptSharedTitle(deps, session);
    session.start();
    sessRef.lastStatus = { connected: false, queuedUpdates: session.queuedUpdates };
    updateChip({ connected: false, queuedUpdates: session.queuedUpdates });
    showToast(record.role === 'spectator' ? 'Watching again — catching up' : 'Session resumed — syncing');
    deps.getView()?.focus();
    return true;
  } catch (err) {
    // KEEP the record on a failed resume: it existed before this attempt and
    // may hold unsynced edits — the default teardown would delete it (audit
    // find, 2026-07-10). Still resumable from the Sessions list.
    // An untagged record (saved before sessions knew their relay) that 404s
    // may simply live on another relay: not proof the room is over.
    const { ended, maybeElsewhere } = resumeFailure(roomsStatus(err), Boolean(record.relay));
    if (sessRef) {
      void teardownFor(sessRef, { resumeFailed: { roomOver: ended } }).catch((e) =>
        surfaceError('collab teardown', e),
      );
    } else if (ended) {
      void deleteRecentRoom(roomId).catch((e) => surfaceError('collab recent rooms', e));
    }
    showToast(maybeElsewhere
      ? 'This session wasn’t found on this relay. If it was on another relay, switch to that one and resume again.'
      : relayFailureMessage(err, { initiating: false, verb: 'resume' }));
    return false;
  }
}
