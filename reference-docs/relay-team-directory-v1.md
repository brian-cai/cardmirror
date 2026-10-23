# Relay extension: team directory, v1

An optional extension to the CardMirror relay protocol. It lets a relay keep one shared team
list per team (the same team as in team sessions v1: the relay derives it from the bearer
token): the team's name, its people (display name and send code), its groups, and its team
key. Clients that support it import the list in one step and keep it in sync; clients that
don't are unaffected. Any relay may implement it; clients must treat it as optional. This
document is meant to be public: nothing in it is specific to one operator.

The directory is not end-to-end encrypted: the relay operator can read it, including the
team key, which therefore protects team-session listings from other teams but not from the
operator. Cards and co-edited documents are unaffected (they stay sealed as in the base
protocol).

## Discovery

`GET {base}/ext/team-directory/v1` with the bearer token → `200 {"v":1,"maxPeople":200,"maxGroups":50}`.
Any other answer means unsupported.

## The directory

```json
{
  "v": 1,
  "name": "Lincoln HS Debate",
  "people": [ { "code": "<send code>", "name": "Sam Lee", "self": true } ],
  "groups": [ { "label": "Varsity", "members": ["<send code>", "..."] } ],
  "teamKey": "<base64url 32 bytes, or absent>",
  "revision": 17,
  "updatedAt": 1792700000000
}
```

- `code` is a CardMirror send code (the routing code people already share to add contacts),
  normalized as the client normalizes it. `name` is at most 60 characters.
- `self: true` marks an entry the person registered themselves (below); other entries were
  added by whoever manages the team.
- `revision` increases on every change; clients compare it to know when to re-import.

## Endpoints (bearer token; errors are `{"detail": ...}`)

| Method | Path | Body / result |
|---|---|---|
| GET | `/team-directory` | → the directory (`200`); `If-None-Match: "<revision>"` → `304` when unchanged. An empty team gets `{"v":1,"name":"","people":[],"groups":[],"revision":0}`. |
| PUT | `/team-directory/me` | `{"code","name"}` → `200 {revision}`. Adds or updates the caller's own entry, matched by `code`; marks it `self`. The relay ties the entry to the caller's install, so one install can hold one entry: a second PUT from the same install with a different code replaces its previous entry. |
| DELETE | `/team-directory/me?code=<send code>` | → `204`. Removes the caller's own entry. `code` names which one; a relay may accept the call without it when the token can only belong to one person, but a token shared by many people needs it (`400` otherwise). Idempotent. |
| PUT | `/team-directory/team-key` | `{"teamKey"}` → `201` when the team had none; `409 {"teamKey": <existing>}` when it already has one (first write wins, so two clients racing end up with one key). |

People and groups other than your own entry are changed by whoever manages the team, through
the relay operator's own tools (for example a purchase's manage page); there is no client
endpoint for editing other people.

## Client behaviour (recommended)

- After connecting to a relay that supports the extension, fetch the directory. If it lists
  people this install doesn't have, offer once: "Your team (<name>) is set up on this relay.
  Import it?" Importing asks for (or confirms) the user's display name, registers it with
  `PUT /team-directory/me`, then merges people, groups and the team key exactly as importing a
  team file does (existing contacts keep their names; a local team key is never replaced
  silently).
- Afterwards, re-fetch with `If-None-Match` when the collaboration settings open, on start, and
  every few minutes (a 304 is cheap), and merge any new people and groups.
- If the team has no key and this client has one, offer it with `PUT /team-directory/team-key`;
  on `409`, adopt the returned key under the same merge rule.
- Never send anything other than this install's own display name and send code. Always pass `?code=` when removing your own entry.

## Privacy properties

- A team sees only its own directory; other teams get their own (`team` is derived from the
  token, never named by the client).
- The relay learns the names and send codes people chose to share with their team, and the
  team key. It still cannot read cards or documents.
