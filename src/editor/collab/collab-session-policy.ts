/**
 * Decisions the session flows make, as plain functions with no UI: which relay a session needs, whether a relay error means the room is over, what a teardown keeps, and how a relay failure is explained. Split out of collab-ui.ts so they can be unit-tested.
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
  if (err instanceof RoomsError && (err.status === 410 || err.status === 404)) {
    return 'That co-editing session has ended — ask for a fresh invite to start a new one.';
  }
  return `Could not ${opts.verb}: ${(err as Error).message}`;
}
