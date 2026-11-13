/**
 * The Join session dialog: a box to paste a share code or invite link into
 * — focused, so a new join is paste-and-Enter with no click first — and,
 * below it, the sessions this user can get back into, laid out like the
 * home screen's Sessions list.
 *
 * Two sources, merged by room:
 *  - SAVED sessions (collab-store session records): a copy kept on this
 *    machine, from closing with "keep", a crash, a full room or a failed
 *    resume. Rejoining resumes it, flushing any edits that never synced.
 *  - LEFT sessions (recent rooms): rooms the user left whose credentials
 *    are remembered for a week. Rejoining is a fresh join, while the room
 *    is still alive on the relay.
 * Rooms already live in this window are left out. Either kind rejoins
 * through joinSessionWithCode, which resumes when a record exists.
 *
 * With team sessions (team-sessions.ts) on, a third section lists the
 * team's listed sessions: Join for an open one (its share code is in
 * the listing), Request to join for the rest. It loads after the dialog
 * opens and refreshes while it stays open; with the feature off it never
 * appears.
 */

import { relativeTime } from '../disk-conflict.js';
import { getElectronHost } from '../host/index.js';
import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { isBackdropClick } from '../backdrop-click.js';
import { installModalKeys, captureFocusForDialog, armDialogFocus } from '../text-prompt.js';
import {
  listSessionRecords,
  listRecentRooms,
  deleteRecentRoom,
  type PersistedSessionRecord,
  type RecentRoomRecord,
} from './collab-store.js';
import { currentRelayTag, relayLabelForTag } from '../pairing/contact-relays.js';
import type { SessionRole } from './session-role.js';
import type { HistoryMeta } from '../host/types.js';

export interface RejoinCandidate {
  roomId: string;
  shareCode: string;
  guestPass: string | null;
  role: SessionRole;
  title: string;
  /** 'saved': a local copy to resume; 'left': a remembered room to rejoin. */
  kind: 'saved' | 'left';
  at: number;
  /** The relay the room lives on (contact-relays.ts tag), when recorded. */
  relay?: string;
  /** From the room's session-history file, when this machine kept one. */
  details?: SessionDetails;
}

/** Who and what a session was, from its history file. */
export interface SessionDetails {
  startedBy?: string;
  people: string[];
  /** First and last time this machine was in it. */
  usedFrom: number;
  usedTo: number;
  fileName?: string;
  /** The local file's last save; null = no file (never saved, or gone). */
  savedAt: number | null;
}

/** An ended (or no longer rejoinable) session this machine has history
 *  for: opening it offers its versions as a new document. */
export interface PastSession {
  roomId: string;
  title: string;
  role?: SessionRole;
  details: SessionDetails;
}

/** A team session row for the dialog (team-sessions.ts TeamSessionEntry). */
export interface TeamSessionRow {
  roomId: string;
  name: string;
  startedBy: string;
  participants: number;
  lastActivity: number;
  mode: 'open' | 'request';
  shareCode: string | null;
  /** Who's in it (the host's listing), when it says. */
  people?: string[];
}

/** Where the Team sessions section comes from. `load` resolves null when
 *  the feature is off (no section); `request` resolves a line to show. */
export interface TeamSessionsSource {
  load(): Promise<TeamSessionRow[] | null>;
  request(row: TeamSessionRow): Promise<{ ok: boolean; message: string }>;
  alreadyRequested(roomId: string): boolean;
  /** Refresh period while the dialog is open (default 15 s). */
  refreshMs?: number;
}

export const TEAM_REQUEST_SENT_MESSAGE = 'Request sent; you\u2019ll join as soon as someone approves';

/** "Ana, Ben and 2 others", or the head count when the listing names nobody. */
export function whoIsIn(row: Pick<TeamSessionRow, 'participants' | 'people'>): string {
  const names = row.people ?? [];
  const n = Math.max(row.participants, names.length);
  if (n === 0) return 'nobody in it now';
  if (!names.length) return n === 1 ? '1 person in it' : `${n} people in it`;
  const shown = names.slice(0, 3);
  const rest = n - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}` : shown.join(', ').replace(/, ([^,]*)$/, ' and $1');
}


export type RejoinPick =
  | { kind: 'rejoin'; shareCode: string; guestPass: string | null; relay?: string }
  /** A past session: open a version of it from its history file. */
  | { kind: 'history'; roomId: string; title: string }
  /** What was typed or pasted into the box: a share code or an invite link. */
  | { kind: 'code'; text: string };

/** Saved sessions first-class (they hold local edits), then left rooms not
 *  already covered by a saved one; newest first; live rooms dropped. */
export function buildRejoinCandidates(
  records: readonly PersistedSessionRecord[],
  recents: readonly RecentRoomRecord[],
  isLive: (roomId: string) => boolean,
): RejoinCandidate[] {
  const out: RejoinCandidate[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (isLive(r.roomId)) continue;
    seen.add(r.roomId);
    const recent = recents.find((x) => x.roomId === r.roomId);
    out.push({
      roomId: r.roomId,
      shareCode: r.shareCode,
      guestPass: r.guestPass ?? recent?.guestPass ?? null,
      role: r.role,
      title: r.docTitle || recent?.docTitle || '',
      kind: 'saved',
      at: r.updatedAt,
      ...((r.relay ?? recent?.relay) ? { relay: r.relay ?? recent?.relay } : {}),
    });
  }
  for (const r of recents) {
    if (seen.has(r.roomId) || isLive(r.roomId)) continue;
    out.push({
      roomId: r.roomId,
      shareCode: r.shareCode,
      guestPass: r.guestPass ?? null,
      role: r.role,
      title: r.docTitle,
      kind: 'left',
      at: r.leftAt ?? r.lastActiveAt,
      ...(r.relay ? { relay: r.relay } : {}),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function loadRejoinCandidates(isLive: (roomId: string) => boolean): Promise<RejoinCandidate[]> {
  const [records, recents] = await Promise.all([listSessionRecords(), listRecentRooms()]);
  return buildRejoinCandidates(records, recents, isLive);
}

/** This machine's session-history files (desktop; kept 30 days). */
export async function loadSessionHistory(): Promise<HistoryMeta[]> {
  try {
    return (await getElectronHost()?.listHistory()) ?? [];
  } catch {
    return [];
  }
}

export function detailsFromHistory(m: HistoryMeta): SessionDetails {
  return {
    ...(m.info?.startedBy ? { startedBy: m.info.startedBy } : {}),
    people: m.info?.people ?? [],
    usedFrom: m.startedAt,
    usedTo: m.updatedAt,
    ...(m.info?.fileName ? { fileName: m.info.fileName } : {}),
    savedAt: m.savedAt ?? null,
  };
}

/** Give rejoinable rows their history details, and list every other
 *  history file as a past session (newest first). Rooms live in this
 *  window are neither. */
export function withSessionHistory(
  candidates: readonly RejoinCandidate[],
  history: readonly HistoryMeta[],
  isLive: (roomId: string) => boolean,
): { candidates: RejoinCandidate[]; past: PastSession[] } {
  const byRoom = new Map(history.map((m) => [m.roomId, m]));
  const out = candidates.map((c) => {
    const m = byRoom.get(c.roomId);
    return m ? { ...c, details: detailsFromHistory(m) } : c;
  });
  const listed = new Set(candidates.map((c) => c.roomId));
  const past = history
    .filter((m) => !listed.has(m.roomId) && !isLive(m.roomId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((m) => ({
      roomId: m.roomId,
      title: m.docTitle,
      ...(m.info?.role ? { role: m.info.role } : {}),
      details: detailsFromHistory(m),
    }));
  return { candidates: out, past };
}

const fmtDay = (t: number): string =>
  new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtTime = (t: number): string => new Date(t).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

/** "Nov 9, 3:10 PM – 5:42 PM" (one day) or "Nov 9, 3:10 PM – Nov 10, 9:02 AM". */
export function usedRange(from: number, to: number): string {
  if (!from || !to || to - from < 60_000) return fmtDay(to || from);
  const sameDay = new Date(from).toDateString() === new Date(to).toDateString();
  return `${fmtDay(from)} \u2013 ${sameDay ? fmtTime(to) : fmtDay(to)}`;
}

/** "Alex, Sam, Jo and 2 others". */
export function namesLine(names: readonly string[], max = 4): string {
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} other${rest === 1 ? '' : 's'}`;
  return shown.join(', ').replace(/, ([^,]*)$/, ' and $1');
}

/** The local-file part of a row: "Aff.cmir · saved 2h ago". */
export function fileLine(d: Pick<SessionDetails, 'fileName' | 'savedAt'>): string {
  const name = d.fileName && !/^untitled\b/iu.test(d.fileName) ? d.fileName : '';
  if (d.savedAt) return `${name || 'Your copy'} \u00b7 saved ${relativeTime(d.savedAt)}`;
  return name ? `${name} \u00b7 not saved` : 'not saved to a file';
}

/** A row's body: the name first and largest, then who started it, then
 *  who was in it, then when and the local file. Lines with nothing to
 *  say are left out. Returns the text the search box matches. */
function fillSessionBody(
  body: HTMLElement,
  o: { title: string; chip?: string; startedBy?: string; people?: string; when?: string; extra?: string },
): string {
  const top = document.createElement('span');
  top.className = 'pmd-rejoin-card-top';
  const name = document.createElement('span');
  name.className = 'pmd-rejoin-card-name';
  name.textContent = o.title || 'Collaboration session';
  name.title = name.textContent;
  top.appendChild(name);
  if (o.chip) {
    const chip = document.createElement('span');
    chip.className = 'pmd-home-recent-format pmd-home-session-role pmd-rejoin-card-chip';
    chip.textContent = o.chip;
    top.appendChild(chip);
  }
  body.appendChild(top);
  const line = (cls: string, text: string | undefined): void => {
    if (!text) return;
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    el.title = text;
    body.appendChild(el);
  };
  line('pmd-rejoin-card-by', o.startedBy ? `Started by ${o.startedBy}` : undefined);
  line('pmd-rejoin-card-meta', o.people);
  line('pmd-rejoin-card-meta', o.when);
  line('pmd-rejoin-card-meta', o.extra);
  return [o.title, o.startedBy, o.people, o.when, o.extra].filter(Boolean).join(' ').toLowerCase();
}

const roleChip = (role: SessionRole | undefined): string | undefined =>
  role === 'host' ? 'HOST' : role === 'spectator' ? 'WATCHED' : role === 'participant' ? 'JOINED' : undefined;

function detailLines(d: SessionDetails | undefined, role: SessionRole | undefined): {
  startedBy?: string;
  people?: string;
  when?: string;
} {
  if (!d) return {};
  const startedBy = d.startedBy ?? (role === 'host' ? 'you' : undefined);
  const people = d.people.length ? `With ${namesLine(d.people)}` : undefined;
  const when = `Used ${usedRange(d.usedFrom, d.usedTo)} \u00b7 ${fileLine(d)}`;
  return { ...(startedBy ? { startedBy } : {}), ...(people ? { people } : {}), when };
}

function describe(c: RejoinCandidate): string {
  // "last here", not "left": a crash records no leave time.
  const when = c.kind === 'saved' ? `saved ${relativeTime(c.at)}` : `last here ${relativeTime(c.at)}`;
  if (!c.relay) return when;
  const here = c.relay === currentRelayTag();
  return `${when} \u00b7 on ${relayLabelForTag(c.relay)}${here ? '' : ' (switches relay)'}`;
}

/** Typed text that is a code or link, not a search. */
const looksLikeCode = (t: string): boolean => /^cmshare|#|^https?:/i.test(t.trim());

/** The dialog. Resolves with a session to rejoin, the text entered in the
 *  box, or null on cancel. With no candidates it is just the box. */
export function pickSessionToJoin(
  candidates: RejoinCandidate[],
  team?: TeamSessionsSource,
  past: readonly PastSession[] = [],
): Promise<RejoinPick | null> {
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-rejoin-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'Join or rejoin a session';
    dialog.appendChild(header);

    let settled = false;
    let removeKeys = (): void => {};
    let teamTimer: ReturnType<typeof setInterval> | null = null;
    const finish = (value: RejoinPick | null): void => {
      if (settled) return;
      settled = true;
      if (teamTimer !== null) clearInterval(teamTimer);
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve(value);
    };

    // ── Paste box: first, and focused ─────────────────────────────────
    const entry = document.createElement('div');
    entry.className = 'pmd-rejoin-entry';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pmd-text-prompt-input pmd-rejoin-input';
    input.placeholder = 'Paste a session code or invite link, or type to search';
    input.setAttribute('aria-label', 'Session code or invite link');
    input.autocomplete = 'off';
    input.spellcheck = false;
    entry.appendChild(input);
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'pmd-text-prompt-ok pmd-rejoin-join';
    join.textContent = 'Join';
    const submit = (): void => {
      const text = input.value.trim();
      if (text) finish({ kind: 'code', text });
      else input.focus();
    };
    join.addEventListener('click', submit);
    // Typing (not a code) filters every list below by name, people and relay.
    const applyFilter = (): void => {
      const t = input.value.trim().toLowerCase();
      const q = t && !looksLikeCode(t) ? t : '';
      for (const el of dialog.querySelectorAll<HTMLElement>('.pmd-rejoin-row')) {
        el.hidden = q !== '' && !(el.dataset['search'] ?? '').includes(q);
      }
    };
    input.addEventListener('input', applyFilter);
    entry.appendChild(join);
    dialog.appendChild(entry);

    // The lists share one scrolling body between the box and the footer, so
    // the dialog never grows past the window and Cancel stays on screen.
    const body = document.createElement('div');
    body.className = 'pmd-rejoin-body';
    dialog.appendChild(body);

    // ── Sessions to get back into ─────────────────────────────────────
    const section = document.createElement('div');
    section.className = 'pmd-rejoin-section';
    const heading = document.createElement('div');
    heading.className = 'pmd-rejoin-heading';
    heading.textContent = 'Recent sessions';
    section.appendChild(heading);
    const list = document.createElement('div');
    list.className = 'pmd-home-sessions pmd-rejoin-list';
    list.setAttribute('role', 'list');
    section.appendChild(list);
    body.appendChild(section);

    const renderRows = (): void => {
      list.innerHTML = '';
      section.hidden = candidates.length === 0;
      for (const c of candidates) {
        // Same row as the home screen's Sessions list (same classes).
        const wrap = document.createElement('div');
        wrap.className = 'pmd-home-session pmd-rejoin-row';
        wrap.setAttribute('role', 'listitem');

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'pmd-home-session-open pmd-rejoin-btn';
        row.title = c.kind === 'saved' ? 'Rejoin with your saved copy (syncs your edits)' : 'Rejoin this session';
        row.classList.add('pmd-rejoin-card');
        const search = fillSessionBody(row, {
          title: c.title,
          chip: c.role === 'host' ? 'HOST' : c.role === 'spectator' ? 'WATCHING' : 'JOINED',
          ...detailLines(c.details, c.role),
          extra: describe(c),
        });
        row.addEventListener('click', () =>
          finish({ kind: 'rejoin', shareCode: c.shareCode, guestPass: c.guestPass, ...(c.relay ? { relay: c.relay } : {}) }),
        );
        wrap.dataset['search'] = search;
        wrap.appendChild(row);

        // Forgetting a LEFT room only drops its remembered credentials.
        // Saved copies are managed from the home screen's Sessions list,
        // whose ✕ also offers a host End.
        if (c.kind === 'left') {
          const forget = document.createElement('button');
          forget.type = 'button';
          forget.className = 'pmd-home-session-forget pmd-rejoin-forget';
          forget.textContent = '✕';
          forget.title = 'Forget this session';
          forget.setAttribute('aria-label', `Forget ${c.title || 'this session'}`);
          forget.addEventListener('click', () => {
            void deleteRecentRoom(c.roomId).catch(() => {});
            candidates = candidates.filter((x) => x.roomId !== c.roomId);
            renderRows();
            input.focus();
          });
          wrap.appendChild(forget);
        } else {
          // Same width as a ✕, so every row's time lines up.
          const spacer = document.createElement('span');
          spacer.className = 'pmd-home-session-forget pmd-rejoin-spacer';
          spacer.textContent = '✕';
          spacer.setAttribute('aria-hidden', 'true');
          wrap.appendChild(spacer);
        }
        list.appendChild(wrap);
      }
    };
    renderRows();

    // ── Team sessions (relay extension; absent when off) ──────────────
    if (team) {
      const teamSection = document.createElement('div');
      teamSection.className = 'pmd-rejoin-section pmd-rejoin-team';
      teamSection.hidden = true;
      const teamHeading = document.createElement('div');
      teamHeading.className = 'pmd-rejoin-heading';
      teamHeading.textContent = 'Team sessions';
      teamSection.appendChild(teamHeading);
      const teamList = document.createElement('div');
      teamList.className = 'pmd-home-sessions pmd-rejoin-list';
      teamList.setAttribute('role', 'list');
      teamSection.appendChild(teamList);
      const teamNote = document.createElement('div');
      teamNote.className = 'pmd-rejoin-team-note';
      teamNote.hidden = true;
      teamSection.appendChild(teamNote);
      body.appendChild(teamSection);

      const sent = new Set<string>();
      const renderTeam = (rows: TeamSessionRow[]): void => {
        teamList.innerHTML = '';
        teamSection.hidden = rows.length === 0;
        for (const r of rows) {
          const wrap = document.createElement('div');
          wrap.className = 'pmd-home-session pmd-rejoin-row';
          wrap.setAttribute('role', 'listitem');
          const info = document.createElement('div');
          info.className = 'pmd-home-session-open pmd-rejoin-team-info pmd-rejoin-card';
          const search = fillSessionBody(info, {
            title: r.name,
            startedBy: r.startedBy,
            people: whoIsIn(r),
            ...(r.lastActivity > 0 ? { when: `Active ${relativeTime(r.lastActivity)}` } : {}),
          });
          wrap.appendChild(info);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'pmd-rejoin-team-btn';
          if (r.mode === 'open' && r.shareCode) {
            btn.textContent = 'Join';
            const code = r.shareCode;
            btn.addEventListener('click', () => finish({ kind: 'rejoin', shareCode: code, guestPass: null }));
          } else if (sent.has(r.roomId) || team.alreadyRequested(r.roomId)) {
            btn.textContent = 'Request sent';
            btn.disabled = true;
          } else {
            btn.textContent = 'Request to join';
            btn.addEventListener('click', () => {
              btn.disabled = true;
              btn.textContent = 'Sending\u2026';
              void team.request(r).then((res) => {
                if (res.ok) sent.add(r.roomId);
                btn.textContent = res.ok ? 'Request sent' : 'Request to join';
                btn.disabled = res.ok;
                teamNote.hidden = false;
                teamNote.textContent = res.message;
              });
            });
          }
          wrap.appendChild(btn);
          wrap.dataset['search'] = search;
          teamList.appendChild(wrap);
        }
      };
      const loadTeam = (): void => {
        void team.load().then(
          (rows) => {
            if (settled || !rows) return;
            renderTeam(rows);
            applyFilter();
          },
          () => {},
        );
      };
      loadTeam();
      teamTimer = setInterval(loadTeam, team.refreshMs ?? 15_000);
    }

    // ── Past sessions: history this machine kept (30 days) ────────────
    if (past.length) {
      const pastSection = document.createElement('div');
      pastSection.className = 'pmd-rejoin-section pmd-rejoin-past';
      const pastHeading = document.createElement('div');
      pastHeading.className = 'pmd-rejoin-heading';
      pastHeading.textContent = 'Past sessions';
      pastSection.appendChild(pastHeading);
      const pastList = document.createElement('div');
      pastList.className = 'pmd-home-sessions pmd-rejoin-list';
      pastList.setAttribute('role', 'list');
      for (const p of past) {
        const wrap = document.createElement('div');
        wrap.className = 'pmd-home-session pmd-rejoin-row';
        wrap.setAttribute('role', 'listitem');
        const info = document.createElement('div');
        info.className = 'pmd-home-session-open pmd-rejoin-team-info pmd-rejoin-card';
        const chip = roleChip(p.role);
        wrap.dataset['search'] = fillSessionBody(info, {
          title: p.title,
          ...(chip ? { chip } : {}),
          ...detailLines(p.details, p.role),
        });
        wrap.appendChild(info);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pmd-rejoin-team-btn';
        btn.textContent = 'Open a copy';
        btn.title = 'Pick a point in this session and open it as a new document';
        btn.addEventListener('click', () => finish({ kind: 'history', roomId: p.roomId, title: p.title }));
        wrap.appendChild(btn);
        pastList.appendChild(wrap);
      }
      pastSection.appendChild(pastList);
      body.appendChild(pastSection);
    }

    const footer = document.createElement('div');
    footer.className = 'pmd-rejoin-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'pmd-route-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => finish(null));
    footer.appendChild(cancel);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) finish(null);
    });
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        finish(null);
        return true;
      }
      // Enter in the box joins; on a row or a button it activates that.
      if (e.key === 'Enter' && document.activeElement === input) {
        submit();
        return true;
      }
      return false;
    });
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', 'Join or rejoin a session');
    // The box takes focus: paste, Enter. (After the dialog's own focus, as
    // the text prompt does.)
    setTimeout(() => input.focus(), 0);
    // A session code or invite link already on the clipboard (the host just
    // sent it in a chat) fills the box, selected, so Enter joins and any
    // typing replaces it. Desktop only: a browser would ask for clipboard
    // permission.
    void getElectronHost()
      ?.clipboardReadText()
      .then((clip) => {
        const text = looksLikeSessionCode(clip);
        if (!text || settled || input.value) return;
        input.value = text;
        input.select();
      })
      .catch(() => {});
  });
}

/** The clipboard text when it is exactly one session code or join link
 *  (cmshare1/2, cmview1, or an https link with #join=…), else null. */
export function looksLikeSessionCode(clip: unknown): string | null {
  if (typeof clip !== 'string') return null;
  const t = clip.trim();
  if (!t || t.length > 2048 || /\s/.test(t)) return null;
  const code = /^(?:cmshare[12]|cmview1)\./;
  if (code.test(t)) return t;
  const hash = t.indexOf('#');
  if (/^https?:\/\//.test(t) && hash > 0) {
    const join = new URLSearchParams(t.slice(hash + 1)).get('join') ?? '';
    if (code.test(join)) return t;
  }
  return null;
}
