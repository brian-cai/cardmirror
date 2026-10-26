/**
 * The CollabSession callbacks the UI hands every session: status and offline notices, auth/full/stuck notices, and a remote end. Split out of collab-ui.ts.
 */

import { showToast } from '../toast.js';
import { surfaceError } from '../error-surface.js';
import { relayDeclinedWithDetail } from '../relay-decline.js';
import { isCustomRelay } from './relay-info.js';
import { clearNotice, postNotice } from '../status-notices.js';
import { notifyCollabCopresenceChange } from './collab-hooks.js';
import { type ActiveSession, type CollabUiDeps, sessions } from './collab-ui-state.js';
import { isChipSession, refreshChipForFocus, updateChip } from './collab-chip.js';
import { teardownFor } from './collab-seams.js';

export let offlineNoticeMs = 3 * 60_000;
export function __setOfflineNoticeMsForTests(ms: number | null): void {
  offlineNoticeMs = ms ?? 3 * 60_000;
}

/** In-flight join/resume guards, keyed by room. startSessionFlow had one
 *  (startsInFlight); join and resume did not, so a double-click (or an
 *  invite pill + a Sessions row) raced past the "already installed?"
 *  check before the first call had installed anything — two
 *  ActiveSessions on one room: two persist writers on one IndexedDB
 *  key, two history writers with one silently orphaned (2026-09-01
 *  review, PH-A6). Separate sets: a join that finds a record delegates
 *  to resume for the same room. */

// `getSess` resolves THIS session's ActiveSession lazily — for join/resume the
// entry isn't created (and its owning uid isn't known) until after newSessionDoc
// creates the fresh doc, which is after the CollabSession (and these callbacks)
// exist. Returns null before install / after teardown; callbacks then no-op.
/** Outage length after which reconnecting toasts "Session back online". */
export const BACK_ONLINE_TOAST_MS = 30_000;

export function sessionCallbacks(deps: CollabUiDeps, getSess: () => ActiveSession | null) {
  return {
    onStatus: (s: { connected: boolean; queuedUpdates: number }) => {
      const sess = getSess();
      if (!sess) return;
      // Every session records its own status (each slot footer renders its
      // own); the shared chip still reflects only the focused doc's.
      // Reconnected → re-announce presence (partners saw us absent until
      // the 15s keepalive otherwise).
      if (s.connected && !sess.lastStatus?.connected) sess.cursors.rebroadcast();
      // Prolonged-disconnect notice (see offlineNoticeMs).
      if (!s.connected && sess.lastStatus?.connected !== false) {
        sess.offlineSince = Date.now();
        if (sess.offlineTimer === null) {
          sess.offlineTimer = setTimeout(() => {
            sess.offlineTimer = null;
            const cur = sess.lastStatus;
            if (cur && !cur.connected && sessions.has(sess.ownerUid)) {
              const mins = Math.max(1, Math.round((Date.now() - (sess.offlineSince ?? Date.now())) / 60_000));
              postNotice({
                severity: 'warning',
                title: 'Session offline',
                body:
                  `This session has been disconnected for about ${mins} minute${mins === 1 ? '' : 's'}` +
                  (cur.queuedUpdates > 0 ? ` with ${cur.queuedUpdates} edit${cur.queuedUpdates === 1 ? '' : 's'} waiting to send` : '') +
                  '. Edits are saved locally and keep retrying.',
                key: 'collab-offline',
              });
            }
          }, offlineNoticeMs);
        }
      } else if (s.connected && sess.lastStatus?.connected === false) {
        // Back after a noticeable outage → say so (a blip of a few seconds
        // during a relay deploy shouldn't toast).
        if (sess.offlineSince !== null && Date.now() - sess.offlineSince >= BACK_ONLINE_TOAST_MS) {
          showToast(
            s.queuedUpdates > 0
              ? `Session back online \u2014 sending ${s.queuedUpdates} edit${s.queuedUpdates === 1 ? '' : 's'}`
              : 'Session back online',
          );
        }
        if (sess.offlineTimer !== null) {
          clearTimeout(sess.offlineTimer);
          sess.offlineTimer = null;
        }
        sess.offlineSince = null;
        clearNotice('collab-offline');
      }
      // emitStatus fires from flush() and from every successful post —
      // several times a second while typing. An unchanged status must
      // not repaint every slot footer (each calls into the wasm presence
      // store) and rebuild the presence dots (2026-09-01 review, PH-A11).
      const prev = sess.lastStatus;
      sess.lastStatus = s;
      if (prev && prev.connected === s.connected && prev.queuedUpdates === s.queuedUpdates) return;
      if (isChipSession(sess.ownerUid)) updateChip(s);
      notifyCollabCopresenceChange();
    },
    onPresence: (bytes: Uint8Array) => getSess()?.cursors.applyRemote(bytes),
    onGuestAuthExpired: () => {
      // Terminal-cause notice for a guest whose (immutable, 7-day) pass
      // the relay refused: onEnded fires right after this and its toast
      // says the session ended — this says WHY, and what to do about it.
      postNotice({
        severity: 'error',
        title: 'Session invite expired',
        body:
          'Your invite to this session has expired, so it can’t reconnect. ' +
          'Ask the host for a fresh invite link if the session is still going. ' +
          'This copy of the document is yours to keep.',
        key: 'collab-guest-expired',
      });
    },
    onAuthRejected: (detail: string) => {
      // Mid-session 401/403 — without this the endless retry loop reads
      // exactly like being offline (audit find, 2026-07-10). Fired once
      // per session by CollabSession. A custom relay's own reason (its
      // install limit) is shown whole: the credentials are fine.
      const own = !!detail.trim() && isCustomRelay();
      postNotice({
        severity: 'error',
        title: own ? 'Your relay refused this install' : 'Session credentials rejected',
        body:
          relayDeclinedWithDetail('The session relay rejected your credentials.', detail) +
          ' Your edits are saved locally and keep retrying.',
        key: 'collab-401',
        ...(own ? { full: true } : {}),
      });
    },
    onSendStuck: (n: number) => {
      // Head-of-line blocking used to retry a poison queue entry forever
      // with exponential backoff and no user-visible outcome (2026-09-01
      // review, SC14).
      if (n === 0) {
        clearNotice('collab-send-stuck');
        return;
      }
      postNotice({
        severity: 'warning',
        title: 'Edits aren\u2019t reaching the session',
        body:
          `The last ${n} attempts to send your edits were refused by the relay. They are saved ` +
          'locally and keep retrying; if this persists, save the document and rejoin.',
        key: 'collab-send-stuck',
      });
    },
    onCrowdedOut: () => {
      // An established session's reconnects keep 409ing past the relay's
      // ghost-reap window: the seat is really taken. Explain once; the
      // stream keeps retrying and reconnects when a seat opens.
      postNotice({
        severity: 'warning',
        title: 'Session is full',
        body:
          'Every seat in this session is taken right now. Your edits are saved ' +
          'locally and you will reconnect automatically when someone leaves.',
        key: 'collab-crowded',
      });
    },
    onBacklogMerged: (_count: number) => {
      // Merge-visibility (M3): a real offline backlog just landed — say
      // so, instead of the doc silently reshaping under the user. The
      // session only fires this after a genuine blind window whose
      // catch-up actually changed the doc (frame counts never mapped to
      // user-perceived edits, so the number is gone from the message).
      showToast('Caught up on edits made while you were offline — recent sections may have moved');
    },
    onEnded: () => {
      // The explicit end/leave flows clean up themselves before the
      // session's onEnded fires; only a REMOTELY ended session (host
      // ended it, room GC'd) reaches past this guard.
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid)) return;
      const wasHost = sess.session.role === 'host';
      void teardownFor(sess, 'remote-end').catch((e) => surfaceError('collab teardown', e));
      refreshChipForFocus(); // repaint from live truth (a stale snapshot left ghost chips — field find, 2026-08-12)
      // Rebuild the OWNER doc's plugin stack — refreshing the focused view
      // left an unfocused owner pane holding dead session plugins (audit
      // find, 2026-07-10).
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
      else deps.refreshPlugins();
      showToast(
        wasHost
          ? 'Collaboration session ended'
          : 'Session ended — this copy is now yours alone',
      );
    },
    onFull: () => {
      const sess = getSess();
      if (!sess || !sessions.has(sess.ownerUid)) {
        showToast('That session is full (10 participants)');
        return;
      }
      // The join/resume half-succeeded over REST before the stream's 409:
      // leaving the session mounted showed "Joined the session" + a dead
      // offline chip forever (audit find, 2026-07-10). Tear down but KEEP
      // the record so the user can rejoin from the Sessions list when
      // someone leaves.
      void teardownFor(sess, 'full').catch((e) => surfaceError('collab teardown', e));
      refreshChipForFocus(); // repaint from live truth (a stale snapshot left ghost chips — field find, 2026-08-12)
      if (deps.refreshPluginsForUid) deps.refreshPluginsForUid(sess.ownerUid);
      else deps.refreshPlugins();
      showToast(
        'The session is full (10 people) — your copy is saved; rejoin from the ' +
          'Sessions list when someone leaves.',
      );
    },
  };
}
