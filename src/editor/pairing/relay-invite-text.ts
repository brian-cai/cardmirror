/**
 * Recognize a relay invite link pasted as text: either the page a coach
 * shares (`https://extinction.gg/relay/join#u=<relay URL>&t=<token>`, made
 * by the relay's manage page; the values sit in the fragment) or the app
 * link that page opens (`xtgg-relay://join?url=…&token=…`). Both become the
 * app-link form, which the main process validates with the same strict
 * parser it uses for links the OS delivers (apps/desktop/src/relay-join-link.ts).
 *
 * Pure, so the recognition is unit-testable.
 */

export type RelayInviteText =
  /** Not an invite link: let the caller treat it as something else. */
  | { kind: 'none' }
  /** An invite link, in app-link form, for main to validate. */
  | { kind: 'link'; link: string }
  /** Looks like an invite link but is missing its relay or token. */
  | { kind: 'broken' };

export function readRelayInviteText(text: string): RelayInviteText {
  const t = text.trim();
  if (!t) return { kind: 'none' };
  if (/^xtgg-relay:/i.test(t)) return { kind: 'link', link: t };
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return { kind: 'none' };
  }
  if (url.protocol !== 'https:' || !/\/relay\/join\/?$/.test(url.pathname)) return { kind: 'none' };
  const f = new URLSearchParams(url.hash.replace(/^#/, ''));
  const u = (f.get('u') ?? '').trim();
  const tok = (f.get('t') ?? '').trim();
  if (!u || !tok) return { kind: 'broken' };
  return { kind: 'link', link: `xtgg-relay://join?url=${encodeURIComponent(u)}&token=${encodeURIComponent(tok)}` };
}
