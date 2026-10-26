/**
 * The ONE fix-path sentence for every relay credential-decline
 * surface (mailbox sends, the push stream, session start/join,
 * mid-session rejection). The toast audit found five independently
 * authored ~25-word phrasings of the same 401 — copy edits now
 * happen here once. Deliberately names BOTH paths (account link and
 * self-hosted relay) and never says "subscription": self-hosting is
 * the documented escape from relay gating, and a 401 can't tell a
 * missing membership from a wrong self-host token.
 *
 * On a custom relay (a team's own, e.g. one joined from an invite link)
 * the account path is wrong advice — that relay has no Debate Decoded
 * accounts — so `relayDeclined()` names the coach and the relay's own
 * contact instead.
 */

import { currentRelayInfo, isCustomRelay } from './collab/relay-info.js';

export const RELAY_FIX_PATH =
  'In Settings → Collaboration, connect your Debate Decoded account or set up your own relay.';

/** The custom-relay sentence. */
export const CUSTOM_RELAY_DECLINED =
  'Your team’s relay didn’t accept this computer. Ask your coach for a new invite link.';

/** Who runs the custom relay in use, when its info document says. */
function operatorContact(): string {
  const support = currentRelayInfo()?.operator?.support ?? '';
  return support ? ` Relay contact: ${support}.` : '';
}

/** The whole message for a credential decline. `lead` is the built-in
 *  relay's opening ("The session relay rejected your credentials."); a
 *  custom relay gets its own sentence instead. */
export function relayDeclined(lead: string): string {
  if (isCustomRelay()) return CUSTOM_RELAY_DECLINED + operatorContact();
  return `${lead} ${RELAY_FIX_PATH}`;
}

/** relayDeclined, except that a custom relay's own explanation (`detail`
 *  — its install limit says how many computers are in use and whom to
 *  ask) is shown whole: it, not us, knows the fix. The mailbox's refusal
 *  notice reads the same (pairing-wiring.ts). */
export function relayDeclinedWithDetail(lead: string, detail: string): string {
  const d = detail.trim();
  if (d && isCustomRelay()) return `The relay refused this install: ${d}`;
  return relayDeclined(lead);
}
