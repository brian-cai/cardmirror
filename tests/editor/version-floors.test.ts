/**
 * This build must accept every invite floor it (or the original CardMirror)
 * stamps. 1.15.x xtgg builds sat below the 1.16.0 spectator floor and
 * dropped every Watch invite with an "update required" toast.
 */
import { describe, it, expect } from 'vitest';
import { appVersion } from '../../src/editor/install-info.js';
import {
  compareAppVersions,
  MOVABLE_ROOMS_MIN_VERSION,
  SPECTATOR_MIN_VERSION,
} from '../../src/editor/relay-protocol.js';
import { ROOM_INVITE_MIN_VERSION } from '../../src/editor/pairing/room-invite.js';

describe('version floors', () => {
  it.each([
    ['spectator', SPECTATOR_MIN_VERSION],
    ['movable rooms', MOVABLE_ROOMS_MIN_VERSION],
    ['room invite', ROOM_INVITE_MIN_VERSION],
  ])('this build (%s floor) is at or above it', (_name, floor) => {
    expect(compareAppVersions(appVersion, floor)).toBeGreaterThanOrEqual(0);
  });
});
