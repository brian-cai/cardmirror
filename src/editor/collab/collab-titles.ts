/**
 * What a session is called: the published title, the default "Filename - Display Name", and the owner doc's name. Split out of collab-ui.ts.
 */

import { CollabSession } from './collab-session.js';
import { type CollabUiDeps, docTitleResolver } from './collab-ui-state.js';

/** The host-published doc title from the room's meta map ('' when the
 *  host predates title publishing or hasn't named the doc). */
/** Meta flag: the host typed a session name of their own (not the doc's). */
export const META_TITLE_CUSTOM = 'titleCustom';

export function titleIsCustom(session: CollabSession): boolean {
  return session.loroDoc.getMap('meta').get(META_TITLE_CUSTOM) === true;
}

/** What to call a session in lists, records and invites: its published
 *  name (the host's typed name or the "Filename - Display Name" default),
 *  else the document's name. */
export function sessionLabel(ownerUid: string | null | undefined, session: CollabSession): string {
  return sharedDocTitle(session) || sessionDocTitle(ownerUid);
}

/** The document's name if it has a real one (a saved file), without the
 *  extension; null for a never-saved "Untitled" document. */
export function namedDocTitle(title: string): string | null {
  const t = title.replace(/\.(docx|cmir)$/iu, '').trim();
  return t && !/^untitled\b/iu.test(t) ? t : null;
}

/** The default session name: "Filename - Display Name" (e.g. "Aff -
 *  Brian"). A never-saved document has no filename, so the date stands in
 *  ("Oct 5, 8:14 PM - Brian") — never "Untitled". No display name set:
 *  just the first part. */
export function defaultSessionName(docName: string | null, displayName: string, now: Date = new Date()): string {
  const first =
    docName ?? now.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const who = displayName.trim();
  return who ? `${first} - ${who}` : first;
}

export function sharedDocTitle(session: CollabSession): string {
  const t = session.loroDoc.getMap('meta').get('title');
  return typeof t === 'string' ? t.trim() : '';
}

/** Adopt the shared title in this window (joiner/resume paths). */
export function adoptSharedTitle(deps: CollabUiDeps, session: CollabSession): void {
  const title = sharedDocTitle(session);
  if (title) deps.setDocTitle?.(title);
}

/** The name to publish/label a session with: the OWNER doc's own filename (via
 *  the host-set resolver), NOT `document.title` — in multi-pane that's every
 *  open doc joined by " · ", so a joiner would inherit a window title naming all
 *  of the host's open docs. Falls back to parsing the single-doc window title
 *  when no resolver is set (tests / pre-wire) or the uid can't be resolved. */
export function sessionDocTitle(ownerUid: string | null | undefined): string {
  const byUid = ownerUid ? docTitleResolver?.(ownerUid) : null;
  if (byUid != null) return byUid.trim();
  const t = document.title;
  const cut = t.lastIndexOf(' — CardMirror');
  if (cut > 0) return t.slice(0, cut);
  return t === 'CardMirror' ? '' : t;
}
