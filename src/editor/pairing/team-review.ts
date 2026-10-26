/**
 * Team review — what a background team sync (the synced team file, a
 * relay's team list) found but may not apply without a yes: members for
 * a group you already have, a new person named like one of your contacts,
 * and the file's sessions for your recents. New people and new groups
 * still go in on their own; these are the changes a shared file or list
 * could use to slip someone into a group you send to.
 *
 * Each source keeps one pending review, offered as a status-bar notice
 * with a Review… button — never a dialog on focus or on a timer; the
 * dialog opens only from that click. "Don't add" remembers each item so
 * the next sync (every few minutes) doesn't ask again; dismissing the
 * notice ("not now") waits until the review has something new.
 *
 * The caller recomputes the review on every sync and calls
 * queueTeamReview with it (or with nothing held, which takes it down).
 */
import { settings, type PairingPartner } from '../settings.js';
import { postNotice, clearNotice } from '../status-notices.js';
import { showToast } from '../toast.js';
import {
  applyHeldChanges,
  describeHeldChanges,
  hasHeldChanges,
  type HeldChanges,
  type TeamFileSession,
} from './team-file.js';

export interface TeamReview {
  /** One pending review per source: 'file' or `dir:<relay key>`. */
  source: string;
  teamName: string;
  held: HeldChanges;
  /** Sessions to add to your recents (Join session). */
  sessions: TeamFileSession[];
  /** After a yes is applied, with the ids of any groups it created and
   *  the contacts as they were before it. */
  onAccept?: (createdGroupIds: string[], partnersBefore: readonly PairingPartner[]) => void | Promise<void>;
  /** After "Don't add". */
  onDecline?: () => void;
}

const DECLINED_KEY = 'pmd-team-review-declined';
const DECLINED_MAX = 500;

const pending = new Map<string, TeamReview>();
/** Signature the user dismissed ("not now") per source, this app run. */
const snoozed = new Map<string, string>();

function readDeclined(): Set<string> {
  try {
    const v = localStorage.getItem(DECLINED_KEY);
    const arr = v ? (JSON.parse(v) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDeclined(set: Set<string>): void {
  try {
    localStorage.setItem(DECLINED_KEY, JSON.stringify([...set].slice(-DECLINED_MAX)));
  } catch {
    /* private mode / quota: it asks again next sync */
  }
}

const topUpKey = (source: string, label: string, code: string): string => `${source}\ngroup\n${label.toLowerCase()}\n${code}`;
const clashKey = (source: string, code: string): string => `${source}\ncontact\n${code}`;

/** The review without anything the user already said "Don't add" to. */
export function withoutDeclined(review: TeamReview): TeamReview {
  const declined = readDeclined();
  const topUps = review.held.topUps
    .map((t) => ({ ...t, members: t.members.filter((m) => !declined.has(topUpKey(review.source, t.label, m.code))) }))
    .filter((t) => t.members.length > 0);
  const inGroups = new Set(topUps.flatMap((t) => t.members.map((m) => m.code)));
  const clashes = review.held.clashes.filter((m) => inGroups.has(m.code) || !declined.has(clashKey(review.source, m.code)));
  return { ...review, held: { topUps, clashes } };
}

const isEmpty = (r: TeamReview): boolean => !hasHeldChanges(r.held) && r.sessions.length === 0;

const signature = (r: TeamReview): string =>
  JSON.stringify([
    r.held.topUps.map((t) => [t.label.toLowerCase(), t.members.map((m) => m.code).sort()]),
    r.held.clashes.map((m) => m.code).sort(),
    r.sessions.map((s) => s.roomId).sort(),
  ]);

const noticeKey = (source: string): string => `team-review:${source}`;

/** The lines a review asks about (also the confirm's body). */
export function describeTeamReview(r: TeamReview): string[] {
  const lines = describeHeldChanges(r.held);
  if (r.sessions.length > 0) {
    const titles = r.sessions.map((s) => `“${s.docTitle}”`);
    lines.push(`• ${r.sessions.length === 1 ? 'a session' : `${r.sessions.length} sessions`} under Join session: ${titles.join(', ')}`);
  }
  return lines;
}

/** Offer `review` (replacing this source's pending one), or take it down
 *  when nothing is left to ask. Never opens a dialog. */
export function queueTeamReview(review: TeamReview): void {
  const r = withoutDeclined(review);
  if (isEmpty(r)) {
    pending.delete(r.source);
    clearNotice(noticeKey(r.source));
    return;
  }
  const sig = signature(r);
  const prev = pending.get(r.source);
  pending.set(r.source, r);
  if (snoozed.get(r.source) === sig) return;
  const fresh = !prev || signature(prev) !== sig;
  if (!fresh) return;
  clearNotice(noticeKey(r.source));
  postNotice({
    severity: 'info',
    key: noticeKey(r.source),
    title: `Team “${r.teamName}” wants to add`,
    body: `${describeTeamReview(r).join('\n')}\n\nNothing is added until you review it.`,
    full: true,
    toast: false,
    action: { label: 'Review…', run: () => void reviewTeamChanges(r.source) },
    onDismiss: () => {
      const cur = pending.get(r.source);
      if (cur) snoozed.set(r.source, signature(cur));
    },
  });
  showToast(`Team \u201c${r.teamName}\u201d has changes for you to review (\u24d8 in the status bar).`);
}

export function pendingTeamReview(source: string): TeamReview | null {
  return pending.get(source) ?? null;
}

/** Yes: apply the pending review for `source`. Resolves true when there
 *  was one. */
export async function acceptTeamReview(source: string): Promise<boolean> {
  const r = pending.get(source);
  if (!r) return false;
  pending.delete(source);
  clearNotice(noticeKey(source));
  const before = settings.get('pairingPartners');
  const out = applyHeldChanges({
    held: r.held,
    ownCode: settings.get('pairingOwnCode'),
    partners: before,
    groups: settings.get('pairingGroups'),
  });
  settings.set('pairingPartners', out.partners);
  settings.set('pairingGroups', out.groups);
  await r.onAccept?.(out.createdGroupIds, before);
  return true;
}

/** "Don't add": remember every item so later syncs don't ask again. */
export function declineTeamReview(source: string): void {
  const r = pending.get(source);
  if (!r) return;
  pending.delete(source);
  clearNotice(noticeKey(source));
  const declined = readDeclined();
  for (const t of r.held.topUps) for (const m of t.members) declined.add(topUpKey(source, t.label, m.code));
  for (const m of r.held.clashes) declined.add(clashKey(source, m.code));
  writeDeclined(declined);
  r.onDecline?.();
}

/** The Review… button: the one place this asks, with a dialog. */
export async function reviewTeamChanges(source: string): Promise<void> {
  const r = pending.get(source);
  if (!r) return;
  const { promptForChoice } = await import('../text-prompt.js');
  const choice = await promptForChoice({
    message: `Add these from “${r.teamName}”?`,
    detail:
      `${describeTeamReview(r).join('\n')}\n\n` +
      'Check each code with the person before adding them to a group you send cards to.',
    choices: [
      { value: 'add', label: 'Add', primary: true },
      { value: 'decline', label: 'Don’t add' },
    ],
    cancelLabel: 'Not now',
  });
  if (choice === 'add') {
    if (await acceptTeamReview(source)) showToast(`Added from team “${r.teamName}”.`);
  } else if (choice === 'decline') {
    declineTeamReview(source);
  } else if (pending.get(source)) {
    snoozed.set(source, signature(pending.get(source)!));
  }
}

/** Test hook: reset module state between cases. */
export function __resetTeamReviewForTests(): void {
  pending.clear();
  snoozed.clear();
}
