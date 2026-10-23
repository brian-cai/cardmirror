/**
 * Shared state of the collaboration UI: the live sessions in this window, the host-set resolvers (focused doc, doc titles, doc ids), which session the chip and actions follow, and the cross-window room claims. Split out of collab-ui.ts; no behaviour of its own.
 */

import type { EditorView } from 'prosemirror-view';
import { collabRoomClaimKey } from './collab-hooks.js';
import { getElectronHost } from '../host/index.js';
import { type CommentsSyncHandle } from './collab-comments.js';
import { type PersistHandle } from './collab-persist.js';
import { type HistoryHandle } from './collab-history.js';
import { type CursorsHandle } from './collab-cursors.js';
import { CollabSession } from './collab-session.js';

export interface CollabUiDeps {
  getView(): EditorView | null;
  refreshPlugins(): void;
  /** The `DocRecord.uid` of the document this session is being started/joined
   *  for — captured at install so the binding plugins only ever attach to that
   *  one doc's view (multi-pane fusion guard). */
  getOwnerUid?(): string | null;
  /** Resolve a doc uid to its live view. A session binds its cursors/comments to
   *  its OWNER's view via this (not the focused view), so in multi-pane each
   *  doc's presence renders in its own pane. Falls back to the focused view. */
  getViewForUid?(uid: string): EditorView | null;
  /** Rebuild the plugin stack of the doc with `uid` (its own view — NOT the
   *  focused one). Session-END paths use this so an unfocused owner pane
   *  doesn't keep dead collab plugins. Falls back to refreshPlugins(). */
  refreshPluginsForUid?(uid: string): void;
  /** Swap THIS window's editor to a fresh unsaved doc for a joined
   *  session — must never spawn a window (the binding installs into the
   *  current view; a spawned window would never get it — field bug on
   *  desktop, 2026-07-03). Resolves false if the user cancelled out of
   *  overwriting unsaved edits. */
  newSessionDoc(): boolean | Promise<boolean>;
  /** Name the (unsaved) session doc in this window: window title, the
   *  filename chip, and the save-as default. Joiners get the host's
   *  title through the room's meta map — without this the window and
   *  the Sessions list just say "collaboration session" (field bug,
   *  2026-07-03). */
  setDocTitle?(title: string): void;
  /** Desktop multi-window: when the current window has a real doc open (not
   *  the disposable starter), spawn a NEW window to host the joined session
   *  and return true — the caller then aborts, and the spawned window runs
   *  the full join itself (so the session + Loro binding land together,
   *  never stranded). Returns false to join in THIS window (starter open, or
   *  single-window / web). */
  spawnJoinWindow?(shareCode: string): boolean;
}

/** One live co-editing session, owned by a single open doc (the map key). A
 *  multi-pane window can hold several — one per doc. */
export interface ActiveSession {
  session: CollabSession;
  shareCode: string;
  ownerUid: string;
  cursors: CursorsHandle;
  commentsSync: CommentsSyncHandle;
  persist: PersistHandle;
  /** Session-history writer ({roomId}.cmir-history). Disposed at
   *  teardown but its FILE is always retained — unlike the session
   *  record, which is deleted on Leave/End/tombstone. */
  history: HistoryHandle;
  wakeCleanup: () => void;
  /** Removes the pagehide goodbye/flush hook. */
  unloadCleanup: () => void;
  /** Unsubscribe the meta-map (title) watcher installed by installSeams. */
  metaUnsub: () => void;
  /** Latest connection status for THIS session. The shared status-bar chip only
   *  ever reflects the focused doc's session; storing status per session lets
   *  each multi-pane slot footer render its own visible doc's state. */
  lastStatus: { connected: boolean; queuedUpdates: number } | null;
  offlineSince: number | null;
  offlineTimer: ReturnType<typeof setTimeout> | null;
  /** Container-safe undo ledger (undo-guard.ts); disposed at teardown. */
  undoGuardDispose: () => void;
  /** Stops this room's team-sessions join-request watcher (no-op when the
   *  feature is off). */
  teamWatchStop: () => void;
}

export const sessions = new Map<string, ActiveSession>();

/** Commit origin for session meta-map writes (title publishing) — excluded
 *  from the session UndoManager alongside comment writes, so Ctrl+Z never
 *  un-publishes the shared title. */
export const META_COMMIT_ORIGIN = 'cm-meta';

/** Focused doc's uid — set by the editor host so no-deps UI helpers (chip,
 *  presence, copy-code, invite) can find the session the user is looking at. */
export let focusedUidResolver: (() => string | null) | null = null;
export function setCollabFocusResolver(fn: (() => string | null) | null): void {
  focusedUidResolver = fn;
}

/** Resolve a doc uid → its display filename, set by the host so no-deps helpers
 *  (invite, persist label) and the start flow name a session after its OWNER
 *  doc rather than `document.title` — which in multi-pane is every open doc
 *  joined by " · ". */
export let docTitleResolver: ((uid: string) => string | null) | null = null;
export function setCollabDocTitleResolver(fn: ((uid: string) => string | null) | null): void {
  docTitleResolver = fn;
}

/** Resolve a doc uid → its persistent docId (null before first save).
 *  The persistence manager stamps it into the session record so the
 *  open-from-disk path can match a file back to its session. */
export let docIdResolver: ((uid: string) => string | null) | null = null;
export function setCollabDocIdResolver(fn: ((uid: string) => string | null) | null): void {
  docIdResolver = fn;
}

/** Whether a session for `roomId` is live in THIS window. */
export function roomLiveInWindow(roomId: string): boolean {
  for (const s of sessions.values()) if (s.session.roomId === roomId) return true;
  return false;
}

/** The session owned by `uid`, or null. */
export function sessionFor(uid: string | null | undefined): ActiveSession | null {
  return uid != null ? sessions.get(uid) ?? null : null;
}

// Cross-window live-session claims. Desktop rides the duplicate-open
// path registry in main; web (Phase 3) rides the WEB LOCKS API — an
// exclusive lock named by the claim key, held for the tab's lifetime
// (the browser releases it automatically when the tab dies, crash
// included, which is exactly the lifetime a claim should have).
// All three are best-effort and swallow everything: an old preload, a
// lockless browser, or a test harness must not break session flows.
export const webHeldClaims = new Map<string, () => void>();

export function claimRoom(roomId: string): void {
  const key = collabRoomClaimKey(roomId);
  try {
    const electron = getElectronHost();
    if (electron) {
      void electron.openPathRegister(key).catch(() => {});
      return;
    }
    if (webHeldClaims.has(key) || typeof navigator.locks?.request !== 'function') return;
    void navigator.locks
      .request(key, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        // null = another tab holds it. We proceed unclaimed (the join
        // guard runs BEFORE the session starts; this path is reached
        // only for sessions already being created here).
        if (!lock) return undefined;
        return new Promise<void>((resolve) => {
          webHeldClaims.set(key, resolve);
        });
      })
      .catch(() => {});
  } catch {
    /* API absent — no cross-window guard, sessions still work */
  }
}
export function releaseRoomClaim(roomId: string): void {
  const key = collabRoomClaimKey(roomId);
  try {
    const electron = getElectronHost();
    if (electron) {
      void electron.openPathRelease(key).catch(() => {});
      return;
    }
    webHeldClaims.get(key)?.();
    webHeldClaims.delete(key);
  } catch {
    /* API absent */
  }
}
export async function roomLiveElsewhere(roomId: string): Promise<boolean> {
  const key = collabRoomClaimKey(roomId);
  try {
    const electron = getElectronHost();
    if (electron) {
      return (await electron.openPathCheck(key))?.takenByOther ?? false;
    }
    if (typeof navigator.locks?.query !== 'function') return false;
    const held = (await navigator.locks.query()).held ?? [];
    return held.some((l) => l.name === key) && !webHeldClaims.has(key);
  } catch {
    return false;
  }
}

/** The session the shared chip / no-deps flows act on: the focused doc's, or —
 *  when focus isn't resolvable (or that doc has no session) — the sole session
 *  if there's exactly one. (A later step adds a per-slot footer so every
 *  session's status shows at once; until then the single chip follows focus.) */
export function chipSession(): ActiveSession | null {
  return (
    sessionFor(focusedUidResolver?.() ?? null) ??
    (sessions.size === 1 ? [...sessions.values()][0]! : null)
  );
}

/** The session UI ACTIONS act on (copy code, invite starred): STRICTLY the
 *  focused doc's session. The sole-session fallback applies only when focus is
 *  unresolvable (no resolver registered — bare single-pane); falling back while
 *  the user is LOOKING at a session-less doc invited partners into a different
 *  doc's session (audit find, 2026-07-10). Display (chipSession) keeps the
 *  fallback — showing the one live session is fine; acting on it is not. */
export function actionSession(): ActiveSession | null {
  const focused = focusedUidResolver?.() ?? null;
  if (focused != null) return sessionFor(focused);
  return sessions.size === 1 ? [...sessions.values()][0]! : null;
}
