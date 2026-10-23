/** The session flows' decisions (collab-session-policy.ts), tested without
 *  any UI: which relay a session needs, whether a relay error ends the room,
 *  and what each kind of teardown keeps. */
import { describe, expect, it } from 'vitest';
import {
  relayFailureMessage,
  resumeFailure,
  roomIsGone,
  roomsStatus,
  sessionRelayPlan,
  teardownPolicy,
} from '../../src/editor/collab/collab-session-policy.js';
import { RoomsError } from '../../src/editor/collab/room-client.js';

describe('sessionRelayPlan', () => {
  const profiles: Record<string, string> = { 'relay-b': 'profile-b' };
  const lookup = (tag: string) => profiles[tag] ?? null;

  it('stays here for an untagged session or one on the current relay', () => {
    expect(sessionRelayPlan(null, 'relay-a', lookup)).toEqual({ kind: 'here' });
    expect(sessionRelayPlan(undefined, 'relay-a', lookup)).toEqual({ kind: 'here' });
    expect(sessionRelayPlan('', 'relay-a', lookup)).toEqual({ kind: 'here' });
    expect(sessionRelayPlan('relay-a', 'relay-a', lookup)).toEqual({ kind: 'here' });
  });

  it('switches to a saved relay first', () => {
    expect(sessionRelayPlan('relay-b', 'relay-a', lookup)).toEqual({ kind: 'switch', profileId: 'profile-b' });
  });

  it('refuses a relay that is not saved here', () => {
    expect(sessionRelayPlan('relay-c', 'relay-a', lookup)).toEqual({ kind: 'not-saved' });
  });
});

describe('room gone / resume failure', () => {
  it('reads the status only from a rooms error', () => {
    expect(roomsStatus(new RoomsError(404, 'x'))).toBe(404);
    expect(roomsStatus(new Error('x'))).toBeNull();
    expect(roomsStatus('nope')).toBeNull();
  });

  it('treats 410 and 404 as a room that is over (join, start)', () => {
    expect(roomIsGone(410)).toBe(true);
    expect(roomIsGone(404)).toBe(true);
    for (const s of [null, 401, 409, 500]) expect(roomIsGone(s)).toBe(false);
  });

  it('a 410 always ends a resumed room', () => {
    expect(resumeFailure(410, true)).toEqual({ ended: true, maybeElsewhere: false });
    expect(resumeFailure(410, false)).toEqual({ ended: true, maybeElsewhere: false });
  });

  it('a 404 ends a tagged record, but an untagged one may be on another relay', () => {
    expect(resumeFailure(404, true)).toEqual({ ended: true, maybeElsewhere: false });
    expect(resumeFailure(404, false)).toEqual({ ended: false, maybeElsewhere: true });
  });

  it('any other failure neither ends the room nor points elsewhere', () => {
    for (const s of [null, 401, 500]) {
      expect(resumeFailure(s, true)).toEqual({ ended: false, maybeElsewhere: false });
      expect(resumeFailure(s, false)).toEqual({ ended: false, maybeElsewhere: false });
    }
  });

  it('explains a gone room instead of the raw status', () => {
    expect(relayFailureMessage(new RoomsError(404, 'rooms request failed: 404'), { initiating: false, verb: 'join' }))
      .toMatch(/has ended/);
    expect(relayFailureMessage(new Error('offline'), { initiating: false, verb: 'join' })).toBe('Could not join: offline');
  });
});

describe('teardownPolicy', () => {
  it('clears the record and forgets the room when the room is over', () => {
    expect(teardownPolicy('remote-end')).toEqual({ keepRecord: false, roomOver: true });
    expect(teardownPolicy('host-end')).toEqual({ keepRecord: false, roomOver: true });
  });

  it('a guest leave or failed join clears the record but keeps the room rejoinable', () => {
    expect(teardownPolicy('guest-leave')).toEqual({ keepRecord: false, roomOver: false });
    expect(teardownPolicy('join-failed')).toEqual({ keepRecord: false, roomOver: false });
  });

  it('closing a doc, a relay switch, and a full room keep the record', () => {
    expect(teardownPolicy('keep-resumable')).toEqual({ keepRecord: true, roomOver: false });
    expect(teardownPolicy('full')).toEqual({ keepRecord: true, roomOver: false });
  });

  it('a failed resume always keeps the record, and forgets the room only when proven over', () => {
    expect(teardownPolicy({ resumeFailed: { roomOver: true } })).toEqual({ keepRecord: true, roomOver: true });
    expect(teardownPolicy({ resumeFailed: { roomOver: false } })).toEqual({ keepRecord: true, roomOver: false });
  });
});
