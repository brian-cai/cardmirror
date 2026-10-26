# Relay extension: relay info, v1

A small, optional extension to the CardMirror relay protocol. It gives a client one place to
learn who runs the relay it is connected to, how its own access stands (plan, expiry,
installs), anything the operator wants users to know (maintenance, an outage), and which
client builds the operator recommends. In the other direction it lets a client say which
build it is and, if the user agrees, what to call this install, so the people managing a
shared credential can tell installs apart. Any relay may implement it; clients must treat
it as optional. This document is meant to be public: nothing in it is specific to one
operator.

## Discovery and the info document

`GET {base}/ext/relay-info/v1` with the bearer token → `200` and the JSON below. Any other
answer (404 included) means the extension is unsupported: clients show nothing new.

```json
{
  "v": 1,
  "operator": {
    "name": "Example Relay",
    "url": "https://relay.example/about",
    "support": "help@relay.example",
    "status": "https://status.relay.example",
    "manage": "https://relay.example/manage"
  },
  "access": {
    "label": "Duo, season",
    "status": "active",
    "expiresAt": 1785542400000,
    "installs": { "used": 3, "max": 4, "idleDays": 30 }
  },
  "notice": { "id": "2026-10-25-maint", "text": "Maintenance Saturday 2-3am ET; sessions resume on their own.", "until": 1792900800000 },
  "clients": [
    { "id": "example-build", "name": "Example build of the app", "latest": "1.15.22",
      "url": "https://example.org/releases/latest", "note": "Free. Adds team sessions." }
  ]
}
```

- Every field except `v` is optional; clients ignore what is absent and anything unknown.
- `operator`: plain facts for an "About this relay" panel. `support` is an email address;
  `url`, `status`, `manage` are https links. Clients open links in the system browser.
- `access`: about the credential making the request, never anyone else's.
  - `label`: the operator's name for the plan or purchase.
  - `status`: `active` or `suspended` (a suspended credential is otherwise refused, so a
    client mostly sees this field in the moment between a payment problem and the fix).
  - `expiresAt`: epoch ms, or absent/null for no expiry.
  - `installs`: how many installs the credential is counted on now, its limit (absent or
    `-1` = unlimited), and after how many idle days an install stops counting.
- `notice`: at most one short operator message (plain text, at most 280 characters, no
  markup). `id` changes whenever the text does: clients show a notice once per `id` and let
  the user dismiss it. Past `until` (epoch ms) clients stop showing it.
- `clients`: client builds the operator recommends, at most 5. `id` matches the client id a
  build sends in `X-Relay-Client` (below); `latest` is that build's newest version. A client
  whose own id is listed and whose version is older than `latest` may show "Update
  available" with `url`. A client must never download or install anything on its own from
  this list. Other entries are informational ("also works with").

Relays should answer from memory (no store write) and may cache the document for a few
seconds; clients fetch it when the user opens the relay settings, on start, and at most once
an hour otherwise.

## What a client may send (optional request headers)

On any request, alongside the base protocol's `X-CardMirror-Version`:

| Header | Value |
|---|---|
| `X-Relay-Client` | `<client id>/<version>`, e.g. `example-build/1.15.22`. At most 64 bytes, `[A-Za-z0-9._-]` and one `/`. |
| `X-Relay-Install-Name` | A name for this install chosen or approved by the user, percent-encoded UTF-8, at most 64 bytes after decoding (e.g. `Sam%27s%20MacBook`). |
| `X-Relay-Install-Name-Prompt` | Optional, only without an install name: how the user answered the client's ask for one, `later` or `never`. A relay records it with the install until a name arrives and shows it to the people managing the access; other values are ignored. Relays that don't know it ignore it, and clients that never ask never send it. |
| `X-Relay-Install` | Optional, on room create (`POST /rooms`) and room stream (`GET /rooms/{id}/stream`) only: this install's mailbox routing code, the same value it polls with as `recipient`, so an install limit also counts computers that only co-edit. A relay that doesn't know it ignores it. |

- Both are optional. A relay must treat requests without them exactly as before, and must
  never refuse a request because of them (invalid values are ignored, not rejected).
- The relay records them with the install the request is counted on (the mailbox recipient
  code, base protocol §8), keeping the latest values. Requests that are not counted against
  an install (room traffic) do not change anything.
- Who sees them: the operator and whoever manages the credential (for a purchase, its buyer
  and managers), as a list of installs with name, client and last-seen time. Never other
  credentials' holders. The relay keeps them only as long as the install record itself.
- Clients must let the user turn `X-Relay-Install-Name` off and should default it to
  something the user already chose to show teammates (their display name), not a device or
  account name read from the system.
- CORS: relays that answer browsers add these headers to `Access-Control-Allow-Headers`.

## Install limit errors

When a new install is refused for the install limit, the `detail` should tell the user what
to do without an account page: how many installs are in use, that installs idle for
`idleDays` stop counting on their own, and the operator's support address if it has one.
Example: `this subscription is already used on 4 installs; an install unused for 30 days
stops counting. For more installs, email help@relay.example`.

## Privacy properties

- The info document reveals nothing about other credentials or other teams.
- The install name and client id are the only new things a relay learns, both chosen by the
  user's client, both optional, both visible to the people managing the credential.
