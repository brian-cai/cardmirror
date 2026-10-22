/**
 * Session access requests over the pairing mailbox.
 *
 * A teammate who was invited to only some of your sessions can ask for
 * more. The request is a sealed pairing message carrying no session
 * data at all — just "may I join?". The host's Receive pill shows it as
 * a row; the host picks which of the sessions they are hosting to
 * share (or none), and each pick goes back as an ordinary `room-invite`.
 * Nothing about the host's sessions is listed to, or readable by, the
 * requester until the host approves.
 *
 * Zero collab/Loro imports, like room-invite.ts: the Receive pill must
 * recognize requests without pulling in the lazy collab module.
 */

import type { SendItem } from './relay-client.js';
import type { InboxItem } from './inbox-store.js';

export const ROOM_ACCESS_REQUEST_ITEM_TYPE = 'room-access-request';

/** First app version whose Receive pill understands access requests.
 *  Older clients drop the message with the update-required toast
 *  instead of rendering a dead card row. Keep in sync with the release
 *  that ships this. */
export const ROOM_ACCESS_REQUEST_MIN_VERSION = '1.16.0';

export function buildRoomAccessRequestItem(): SendItem {
  return {
    label: 'Session access request',
    type: ROOM_ACCESS_REQUEST_ITEM_TYPE,
    sliceJson: { request: 'sessions' },
  };
}

/** True when the inbox item is a (well-formed) access request. */
export function isRoomAccessRequest(item: Pick<InboxItem, 'type' | 'sliceJson'>): boolean {
  if (item.type !== ROOM_ACCESS_REQUEST_ITEM_TYPE) return false;
  const p = item.sliceJson;
  return !!p && typeof p === 'object' && (p as Record<string, unknown>)['request'] === 'sessions';
}
