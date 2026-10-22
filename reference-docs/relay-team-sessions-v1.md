# Relay extension: team sessions, v1

A small, optional extension to the CardMirror relay protocol (the relay endpoints the CardMirror desktop app already uses). It lets a team see the co-editing sessions its members have
started and ask to join them, without the relay ever learning what a session is or how to open
it. Any relay may implement it; clients must treat it as optional. This document is meant to be
public: nothing in it is specific to one operator.

## Concepts

- **Team.** A relay-defined group of credentials. On relays that sell one shared token per
  purchase, a team is every token of that purchase; on a simple self-hosted relay with one
  shared token, the team is everyone holding it. Clients never name a team: the relay derives
  it from the bearer token on every request.
- **Team key.** A random 256-bit key the team's clients share out of band (in the CardMirror
  fork it lives in the `.cmteam` team file). The relay never sees it. Everything that would
  identify a session or a person is encrypted with it (AES-256-GCM, 96-bit random nonce,
  `base64url(nonce || ciphertext || tag)`), so the relay stores only opaque blobs.
- **Listing.** A team-encrypted description of one room, attached to that room. Only rooms
  created by a token of the caller's team can carry the caller's team's listings, and only
  that team can read them back.
- **Join request.** A team-encrypted note from a teammate asking to join a listed room. The
  relay queues it; a participant's client approves by sending the requester a normal sealed
  invite through the existing mailbox (`POST /messages`), then deletes the request.

The relay never stores a share code, a room key, a session name or a person's name in the
clear. Ending a room (`DELETE /rooms/{id}`) or its idle expiry removes its listing and requests.

## Discovery

`GET {base}/ext/team-sessions/v1` → `200 {"v":1,"maxBlobBytes":4096,"requestTtlSeconds":86400}`.
Any other answer (404 included) means the extension is unsupported: clients hide the feature.
Requires the bearer token like every other non-public route.

## Endpoints (all JSON, all need the bearer token; errors are `{"detail": ...}`)

| Method | Path | Body / result |
|---|---|---|
| PUT | `/rooms/{id}/listing` | `{"blob": "<team-encrypted>"}`, at most `maxBlobBytes` after base64url decoding → `204`. Replaces any previous listing. `403` if the room was not created by a token of the caller's team; `404` unknown room; `410` ended room. |
| DELETE | `/rooms/{id}/listing` | → `204` (also when there was none). Same team rule. |
| GET | `/team-sessions` | → `{"sessions":[{"roomId","blob","updatedAt","lastActivity","participants"}]}`: every listed, live room created by the caller's team, newest activity first, at most 200. `participants` is the current number of open room streams (deduplicated by `sid`). |
| POST | `/rooms/{id}/join-requests` | `{"blob": "<team-encrypted>"}` → `201 {"requestId"}`. Only for a room listed for the caller's team. At most 20 pending per room and 5 per caller per room; requests expire after `requestTtlSeconds`. |
| GET | `/rooms/{id}/join-requests` | → `{"requests":[{"requestId","blob","createdAt"}]}` (pending, oldest first). Same team rule. |
| DELETE | `/rooms/{id}/join-requests/{requestId}` | → `204`. Same team rule. Clients delete after approving or denying. |

Timestamps are epoch milliseconds. Rate limits are the relay's own; a `429` means slow down.

## What goes inside the blobs (client contract, not seen by the relay)

Listing plaintext (JSON, before encryption with the team key):
```json
{"v":1, "name":"Aff: K answers", "startedBy":"Sam", "mode":"request" | "open",
 "shareCode": "<only when mode is open>", "client":"cardmirror-xtgg/1.15"}
```
- `mode: open`: the listing carries the share code, so any teammate joins directly.
- `mode: request` (the default): no share code; teammates send a join request and a participant
  approves. Only clients that implement requests should publish `request` listings.

Join request plaintext:
```json
{"v":1, "name":"Alex", "recipientCode":"<the requester's mailbox routing code>",
 "publicKey":"<the requester's sealing public key>", "client":"cardmirror-xtgg/1.15"}
```
Approving = sending a normal sealed session invite (the client's existing invite card) to that
recipient code with that public key, exactly as if the inviter had picked the requester as a
recipient by hand.

Clients poll `GET /rooms/{id}/join-requests` while they are in a listed `request` room (every
15 s is plenty) and `GET /team-sessions` when the join dialog is open. No new stream frame types:
existing room streams carry only the base protocol's `u`, `p` and `end`, so clients without
this extension are unaffected.

## Privacy properties

- The relay learns: which rooms a team has listed, when, how many people are in them, and how
  many join requests exist, all as counts and timestamps. Never names, documents or keys.
- Another team learns nothing: its token never sees your team's listings or requests (`403`).
- Losing the team key (or rotating it) makes old listings unreadable; clients simply re-list
  their open sessions under the new key.
