/**
 * Decisions the session flows make, as plain functions with no UI: which relay
 * a session needs, whether a relay error means the room is over, what a
 * teardown keeps, and how a relay failure is explained. Split out of
 * collab-ui.ts so they can be unit-tested.
 */

import { RELAY_FIX_PATH } from '../relay-decline.js';
import { RoomsError } from './room-client.js';

/** Turn a relay failure into a user-actionable message. A 401 is the
 *  gating/auth signal — for INITIATING a session (send-gated per §5.4:
 *  paid initiates, free joins) that means a subscription is required;
 *  for join/resume it means the relay rejected the credentials. The
 *  401 is inherently ambiguous between "hosted relay, needs a paid
 *  account" and "self-host, wrong token", so the message names both
 *  without asserting which. Any non-401 keeps its raw reason. */
export function relayFailureMessage(err: unknown, opts: { initiating: boolean; verb: string }): string {
  if (err instanceof RoomsError && err.status === 401) {
    return opts.initiating
      ? 'Starting a collaboration session requires a relay. ' + RELAY_FIX_PATH
      : 'The session relay rejected your credentials. ' + RELAY_FIX_PATH;
  }
  // 410 = the room was ended (host); 404 = the room itself is gone (relay
  // idle GC). Not errors the user can retry into — tell them the session is
  // over rather than leaking the raw "rooms request failed: NNN".
  if (roomIsGone(roomsStatus(err))) {
    return 'That co-editing session has ended — ask for a fresh invite to start a new one.';
  }
  return `Could not ${opts.verb}: ${(err as Error).message}`;
}

/** The relay's HTTP status for a rooms failure, or null for anything else. */
export function roomsStatus(err: unknown): number | null {
  return err instanceof RoomsError ? err.status : null;
}

/** 410 = the host ended the room; 404 = the relay no longer has it (idle GC).
 *  Either way it can't be joined again. */
export function roomIsGone(status: number | null): boolean {
  return status === 410 || status === 404;
}

/** What a failed RESUME means. A 410 always ends the room. A 404 ends it only
 *  for a record that knows its relay: an untagged record (saved before
 *  sessions knew their relay) may simply live on another relay, so the room is
 *  not proven over and the user is told to check there instead. */
export function resumeFailure(status: number | null, tagged: boolean): { ended: boolean; maybeElsewhere: boolean } {
  const ended = status === 410 || (status === 404 && tagged);
  return { ended, maybeElsewhere: !ended && !tagged && status === 404 };
}

/** Which relay a session needs before it can be joined or resumed. Untagged
 *  sessions (older records) go to the relay in use, as before. */
export type SessionRelayPlan =
  | { kind: 'here' }
  | { kind: 'switch'; profileId: string }
  | { kind: 'not-saved' };

export function sessionRelayPlan(
  tag: string | null | undefined,
  currentTag: string,
  profileIdForTag: (tag: string) => string | null | undefined,
): SessionRelayPlan {
  if (!tag || tag === currentTag) return { kind: 'here' };
  const profileId = profileIdForTag(tag);
  return profileId ? { kind: 'switch', profileId } : { kind: 'not-saved' };
}

/** Why a session is being torn down, and what that keeps:
 *  - remote-end: the host ended it or the relay dropped it. Record cleared,
 *    room forgotten from recent rooms (it can't be rejoined).
 *  - host-end: this host ended it (tombstoned). Same as remote-end.
 *  - guest-leave: a guest left. Record cleared; the room stays in recent
 *    rooms, rejoinable from Join session.
 *  - keep-resumable: closing the doc but keeping the session (and a relay
 *    switch). Record kept for the Sessions list.
 *  - full: the stream found the room full after joining. Record kept, so the
 *    user can rejoin when someone leaves.
 *  - join-failed: a join that never got going. Record cleared, room kept.
 *  - resume-failed: record kept (it may hold unsynced edits); the room is
 *    forgotten only when the failure proved it over. */
export type TeardownReason =
  | 'remote-end'
  | 'host-end'
  | 'guest-leave'
  | 'keep-resumable'
  | 'full'
  | 'join-failed'
  | { resumeFailed: { roomOver: boolean } };

export function teardownPolicy(reason: TeardownReason): { keepRecord: boolean; roomOver: boolean } {
  if (typeof reason === 'object') return { keepRecord: true, roomOver: reason.resumeFailed.roomOver };
  switch (reason) {
    case 'remote-end':
    case 'host-end':
      return { keepRecord: false, roomOver: true };
    case 'guest-leave':
    case 'join-failed':
      return { keepRecord: false, roomOver: false };
    case 'keep-resumable':
    case 'full':
      return { keepRecord: true, roomOver: false };
  }
}
