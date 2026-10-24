/**
 * Installing a live session into a doc (plugins, persistence, history, cursors, comments, wake/unload hooks, room claim) and tearing it down again. Split out of collab-ui.ts.
 */

import type { EditorView } from 'prosemirror-view';
import { LoroUndoPlugin, loroSyncPluginKey, loroUndoPluginKey } from 'loro-prosemirror';
import { createUndoGuard } from './undo-guard.js';
import { showToast } from '../toast.js';
import { surfaceError } from '../error-surface.js';
import { warmCausalMarkIndex } from './causal-mark-heal.js';
import { clearNotice, postNotice } from '../status-notices.js';
import { markSyncOrigin } from '../sync-origin.js';
import { readModePlugin } from '../read-mode-plugin.js';
import { registerCollabPluginSource, unregisterCollabPluginSource, setCollabTransactionTagger, notifyCollabCopresenceChange } from './collab-hooks.js';
import { getElectronHost } from '../host/index.js';
import { collabInvariantHealPlugin } from './collab-invariants.js';
import { causalMarkHealPlugin } from './causal-mark-heal.js';
import { installCommentsSync, COMMENTS_COMMIT_ORIGIN } from './collab-comments.js';
import { UndoManager } from 'loro-crdt';
import { attachSessionPersistence } from './collab-persist.js';
import { attachSessionHistory } from './collab-history.js';
import { installCursorPresence, type CursorsHandle } from './collab-cursors.js';
import { collabRepairPlugin, lowestPeerIsLeader } from './collab-repair.js';
import { saveRecentRoom, deleteRecentRoom } from './collab-store.js';
import { resetSessionCommentIds } from '../comments-plugin.js';
import { CollabSession } from './collab-session.js';
import { type ActiveSession, type CollabUiDeps, META_COMMIT_ORIGIN, claimRoom, docIdResolver, releaseRoomClaim, sessions } from './collab-ui-state.js';
import { refreshPresenceDots } from './collab-chip.js';
import { adoptSharedTitle, sessionLabel } from './collab-titles.js';
import { startTeamWatch } from './collab-team-listing.js';
import { teardownPolicy, type TeardownReason } from './collab-session-policy.js';

export let presenceTimer: ReturnType<typeof setInterval> | null = null;


/** Stamp the Loro binding's own transactions as sync-origin: both the
 *  remote-update imports and the init-time content replace carry the
 *  binding's meta, and neither is a user edit — read mode and the AI
 *  coordinator must admit them (rejection desyncs editor from CRDT). */
export function collabTagger(tr: Parameters<typeof markSyncOrigin>[0]): void {
  if (tr.getMeta(loroSyncPluginKey) !== undefined || tr.getMeta(loroUndoPluginKey) !== undefined) {
    markSyncOrigin(tr);
  }
}


/** Wake-from-sleep / network-return hooks (M3): a resumed laptop's
 *  stream socket is silently dead until timeouts notice — restart it
 *  the moment the OS tells us. Desktop: powerMonitor via the host
 *  seam; both editions: the browser 'online' event. */
/** The page is going away — a web tab close or reload, a desktop reload.
 *  Desktop's close flow already said goodbye and drained (and awaited
 *  both) before the window unloads, so there this is an idempotent
 *  leftover; on the web it is the ONLY chance: there is no close flow,
 *  and a plain fetch started during unload is cancelled by the browser.
 *  Both requests go keepalive. Best-effort by nature — the persist record
 *  re-sends unsent ops on resume, and partners expire a silent caret. */
export function installUnloadHooks(session: CollabSession, cursors: CursorsHandle): () => void {
  const onPageHide = (): void => {
    cursors.farewell({ keepalive: true });
    session.flushForUnload();
  };
  window.addEventListener('pagehide', onPageHide);
  return () => window.removeEventListener('pagehide', onPageHide);
}

export function installWakeHooks(session: CollabSession): () => void {
  const onOnline = (): void => session.restart();
  window.addEventListener('online', onOnline);
  const offResume = getElectronHost()?.onPowerResumed?.(() => session.restart()) ?? null;
  // A throttled background tab is exactly where a socket goes stale
  // unnoticed; coming back to the tab is a wake too — but on the web
  // that is every Cmd-Tab, so it reconnects only if the stream is
  // actually stale or sitting out a backoff (web audit 2026-09-04: an
  // unconditional restart() aborted a healthy stream on every tab
  // return). Sleep and network-return keep the unconditional restart:
  // those sockets are dead in practice.
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') session.restartIfStale();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    offResume?.();
  };
}

/** Build a session's seams, register it, and return the ActiveSession. The
 *  cursors/comments bind to the OWNER's view (not focus) so each doc's presence
 *  renders in its own pane. Window-level seams (tagger, presence timer, comment-
 *  id mode) are shared across every live session and retired in `teardownSession`
 *  when the last one ends. `ownerUid` is the map key (the focused doc at start). */
/** `ownerUid` is the map key and the doc the seams bind into. It is passed in
 *  (not re-read from `deps.getOwnerUid()` here) because every caller has already
 *  awaited a confirm dialog and/or a relay round-trip by this point: re-reading
 *  focus now would bind the session onto whatever doc the user has since clicked
 *  into. Callers capture it at the moment that fixes the target — start: the
 *  focused doc when Start was chosen; join/resume: the freshly-created session
 *  doc right after newSessionDoc(). */
export function installSeams(
  session: CollabSession,
  deps: CollabUiDeps,
  shareCode: string,
  ownerUid: string,
): ActiveSession {
  const ownerView = (): EditorView | null =>
    (ownerUid ? deps.getViewForUid?.(ownerUid) ?? null : null) ?? deps.getView();
  // One shared tagger stamps ANY binding transaction (keyed off the Loro plugin
  // meta), so it serves every session; installed while ≥1 is live.
  setCollabTransactionTagger(collabTagger);
  const wakeCleanup = installWakeHooks(session);
  const commentsSync = installCommentsSync(session.loroDoc, ownerView);
  // Recent rooms: kept past a Leave so Join session can offer a rejoin.
  rememberRecentRoom(session, shareCode, sessionLabel(ownerUid, session));
  // M3: crash-surviving session record (home-screen Sessions list resumes it).
  const persist = attachSessionPersistence(
    session,
    shareCode,
    () => sessionLabel(ownerUid, session),
    () => docIdResolver?.(ownerUid) ?? null,
    { onFailure: (n) => noteWriterFailure('collab-persist-failing', 'crash-resume record', n) },
  );
  // Recover Previous Version's durable record: full-history snapshots
  // that survive session end (deliberately including a remote
  // tombstone — an attacker ending the session must not destroy it).
  // Build the causal-heal history index at idle rather than inside the
  // first remote frame's appendTransaction (a full op-log decode on a
  // big doc). Idempotent; the plugin rebuilds on demand regardless.
  const idle = (fn: () => void): void => {
    const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(fn, { timeout: 5000 });
    else setTimeout(fn, 1500);
  };
  idle(() => warmCausalMarkIndex(session.loroDoc));
  const history = attachSessionHistory(
    session,
    () => sessionLabel(ownerUid, session),
    undefined,
    { onFailure: (n) => noteWriterFailure('collab-history-failing', 'session history', n) },
  );
  const cursors = installCursorPresence(session, ownerView);
  const unloadCleanup = installUnloadHooks(session, cursors);
  // One shared timer refreshes the focused session's chip dots AND every slot
  // footer's copresence (peers join/leave/expire between status updates).
  if (presenceTimer === null)
    presenceTimer = setInterval(() => {
      refreshPresenceDots();
      notifyCollabCopresenceChange();
    }, 3000);
  // Comment-id allocation is per-doc now (the host's resolver tests each doc's
  // session state), so nothing to toggle on here — a co-edited doc's new
  // comments get random ids to avoid two peers colliding on the counter.
  // Live title adoption: the host may (re)name the doc mid-session —
  // a session started on an untitled doc was permanently nameless in
  // every joiner window before this, because the title was read exactly
  // once at join/resume. Hosts never adopt (their local filename is the
  // source of truth the republish flows FROM).
  const metaUnsub = session.loroDoc.getMap('meta').subscribe((e) => {
    if (e.by === 'local' || session.role === 'host') return;
    queueMicrotask(() => adoptSharedTitle(deps, session));
  });
  const sess: ActiveSession = {
    session,
    shareCode,
    ownerUid,
    cursors,
    commentsSync,
    persist,
    history,
    wakeCleanup,
    unloadCleanup,
    metaUnsub,
    watchers: 0,
    lastStatus: null,
    offlineSince: null,
    offlineTimer: null,
    undoGuardDispose: () => undoGuard.dispose(),
    teamWatchStop: startTeamWatch(session, shareCode, ownerUid),
  };
  sessions.set(ownerUid, sess);
  // Editors fetch the room's view pass once so "Copy view link" / spectate
  // invites work from any seat, not just the host's. Fire-and-forget: the
  // getters read session.viewPass lazily; a relay without spectators
  // yields null and the view-link affordances stay hidden.
  if (session.role !== 'spectator' && !session.viewPass) {
    void session.ensureViewPass().catch(() => {});
  }
  // Cross-window live-session claim: while this session is live, other
  // windows' Sessions rows (and join-by-code) refuse the same room and focus
  // this window instead — same registry as the duplicate-file-open guard.
  // Best-effort; released in teardownSession (and by main when this window
  // dies).
  claimRoom(session.roomId);
  // A session just appeared — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  const undoManager = new UndoManager(session.loroDoc, {
    excludeOriginPrefixes: [COMMENTS_COMMIT_ORIGIN, META_COMMIT_ORIGIN],
  });
  // Container-safe undo: an undo/redo that would delete a container a
  // partner edited since is reversed and explained (see undo-guard.ts).
  const undoGuard = createUndoGuard({
    doc: session.loroDoc,
    undoManager,
    getView: () => (deps.getViewForUid?.(ownerUid) ?? null) ?? deps.getView(),
    onBlocked: (message) => showToast(message),
  });
  registerCollabPluginSource({
    ownerUid,
    plugins: () => [
      ...session.plugins(),
      // A pre-configured manager (the plugin otherwise builds its own):
      // comment-mirror and meta writes commit with excluded origins, so the
      // undo stack holds ONLY document edits — Ctrl+Z was silently deleting
      // comments/replies session-wide when a comment op sat on top of it
      // (audit find, 2026-07-10). The plugin still adds 'sys:init' and wires
      // its own cursor-restore hooks onto this manager.
      LoroUndoPlugin({ doc: session.loroDoc, undoManager }),
      undoGuard.plugin,
      collabInvariantHealPlugin(),
      // Inserter-intent for the read layers: strips highlight/underline/
      // emphasis/shading inherited by text whose typist never saw the
      // mark (Peritext interior coverage) — see causal-mark-heal.ts.
      causalMarkHealPlugin(session.loroDoc),
      collabRepairPlugin(() =>
        lowestPeerIsLeader(session.loroDoc.peerIdStr, cursors.visiblePeers()),
      ),
      commentsSync.plugin,
      ...cursors.plugins(),
    ],
    ownsUndo: () => true,
    canRedo: () => undoManager.canRedo(),
    // Read-mode clamp (M4): swallow undo/redo entirely while reading — the Loro
    // undo transactions carry the binding meta (→ sync-origin) and would
    // otherwise sail through the read-mode lock and revert real edits.
    undo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : undoGuard.undo(state, dispatch, view),
    redo: (state, dispatch, view) =>
      readModePlugin.getState(state)?.on ? true : undoGuard.redo(state, dispatch, view),
  });
  return sess;
}

/** Dispose one session's seams + drop it from the registry. Window-level shared
 *  seams (tagger / presence timer / comment-id mode) are retired only when the
 *  LAST session ends. `keepRecord` keeps the resumable persisted record (a
 *  cancelled RESUME, or a close-but-keep); terminal paths clear it. Returns the
 *  record-clear promise so terminal callers can await deletion (so a re-read of
 *  the Sessions list doesn't flash a stale row); most callers ignore it. */
/** Tear `sess` down for `reason` (see teardownPolicy for what each keeps). */
export function teardownFor(sess: ActiveSession, reason: TeardownReason): Promise<void> {
  const { keepRecord, roomOver } = teardownPolicy(reason);
  return teardownSession(sess, keepRecord, roomOver);
}

export function teardownSession(
  sess: ActiveSession,
  keepRecord = false,
  /** The room itself is over (ended by the host, remotely, or gone from the
   *  relay): forget it from recent rooms too — it can't be rejoined. */
  roomOver = false,
): Promise<void> {
  // Stop the SESSION itself, not just its UI: the room-full and join/resume
  // failure paths reached here without an explicit stop, and the orphaned
  // CollabSession kept its flush / catch-up / audit timers (and the audit's
  // full-history repost) alive for the window's life against a room this
  // window was no longer in (2026-09-01 review). stop() is idempotent, so
  // the End/Leave/close paths that already stopped are unaffected.
  sess.cursors.farewell(); // departure frame needs the stream — before stop()
  if (sess.offlineTimer !== null) clearTimeout(sess.offlineTimer);
  sess.undoGuardDispose();
  sess.teamWatchStop();
  clearNotice('collab-offline');
  clearNotice('collab-send-stuck');
  void sess.session.stop().catch(() => {});
  unregisterCollabPluginSource(sess.ownerUid);
  sessions.delete(sess.ownerUid);
  // Release the cross-window live-session claim (registered in installSeams).
  releaseRoomClaim(sess.session.roomId);
  // A session went away — repaint slot footers (this doc's may be visible).
  notifyCollabCopresenceChange();
  sess.wakeCleanup();
  sess.unloadCleanup();
  sess.metaUnsub();
  sess.commentsSync.dispose();
  sess.cursors.dispose();
  // History stops writing but its file is NEVER cleared here — the
  // whole point is surviving Leave/End/tombstone. Pruning is age-based,
  // in the main process.
  sess.history.dispose();
  if (roomOver) {
    void deleteRecentRoom(sess.session.roomId).catch((e) => surfaceError('collab recent rooms', e));
  } else {
    rememberRecentRoom(
      sess.session,
      sess.shareCode,
      sessionLabel(sess.ownerUid, sess.session),
      Date.now(),
    );
  }
  let cleared: Promise<void> = Promise.resolve();
  if (keepRecord) sess.persist.dispose();
  else cleared = sess.persist.clear();
  if (sessions.size === 0) {
    setCollabTransactionTagger(null);
    // Last session gone — drop the random-id dedup set so it doesn't grow.
    resetSessionCommentIds();
    if (presenceTimer !== null) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }
  return cleared;
}

/** Record `session`'s room in recent rooms (best-effort). `leftAt` marks a
 *  teardown; omitted on install, which clears an earlier one. */
export function rememberRecentRoom(
  session: CollabSession,
  shareCode: string,
  docTitle: string,
  leftAt?: number,
): void {
  void saveRecentRoom({
    roomId: session.roomId,
    shareCode,
    guestPass: session.guestPass ?? null,
    role: session.role,
    docTitle,
    lastActiveAt: Date.now(),
    ...(leftAt !== undefined ? { leftAt } : {}),
  }).catch((e) => surfaceError('collab recent rooms', e));
}

/** Silent-degradation surfacing (2026-09-01 review, PH-A9): a full disk
 *  or a denied IndexedDB quota used to disable crash recovery AND
 *  Recover Previous Version for the whole session with zero signal —
 *  both writers swallow storage errors by design. Three consecutive
 *  failures post a keyed notice; a later success clears it. */
export function noteWriterFailure(key: string, what: string, consecutive: number): void {
  if (consecutive === 0) {
    clearNotice(key);
    return;
  }
  if (consecutive < 3) return;
  postNotice({
    severity: 'warning',
    title: `Session ${what} isn\u2019t being saved`,
    body:
      `CardMirror could not write the ${what} ${consecutive} times in a row (disk full or ` +
      'storage denied?). Your live session still works; save the document to be safe.',
    key,
  });
}

/** Prolonged-disconnect notice: offline showed only as chip text, and 5
 *  seconds read exactly like 40 minutes. After this long disconnected, a
 *  keyed notice names the queued count; reconnecting clears it. */
