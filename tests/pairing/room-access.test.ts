import { describe, expect, it } from 'vitest';
import {
  buildRoomAccessRequestItem,
  isRoomAccessRequest,
  ROOM_ACCESS_REQUEST_ITEM_TYPE,
} from '../../src/editor/pairing/room-access.js';
import { parseRoomInvite } from '../../src/editor/pairing/room-invite.js';

describe('room access requests', () => {
  it('round-trips and carries no session data', () => {
    const item = buildRoomAccessRequestItem();
    expect(item.type).toBe(ROOM_ACCESS_REQUEST_ITEM_TYPE);
    expect(isRoomAccessRequest(item)).toBe(true);
    expect(JSON.stringify(item.sliceJson)).not.toMatch(/cmshare/);
  });

  it('rejects other item types and malformed payloads', () => {
    expect(isRoomAccessRequest({ type: 'card', sliceJson: { request: 'sessions' } })).toBe(false);
    expect(isRoomAccessRequest({ type: ROOM_ACCESS_REQUEST_ITEM_TYPE, sliceJson: null })).toBe(false);
    expect(isRoomAccessRequest({ type: ROOM_ACCESS_REQUEST_ITEM_TYPE, sliceJson: { request: 'x' } })).toBe(false);
  });

  it('is not mistaken for a room invite', () => {
    expect(parseRoomInvite(buildRoomAccessRequestItem() as never)).toBeNull();
  });
});
