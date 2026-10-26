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

export interface RejoinCandidate {
  roomId: string;
  shareCode: string;
  guestPass: string | null;
  role: 'host' | 'participant';
  title: string;
  /** 'saved': a local copy to resume; 'left': a remembered room to rejoin. */
  kind: 'saved' | 'left';
  at: number;
  /** The relay the room lives on (contact-relays.ts tag), when recorded. */
  relay?: string;
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

export const TEAM_REQUEST_SENT_MESSAGE = 'Request sent; you\u2019ll get an invite when someone approves';

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

function teamMeta(row: TeamSessionRow): string {
  const at = row.lastActivity > 0 ? ` \u00b7 active ${relativeTime(row.lastActivity)}` : '';
  return `${whoIsIn(row)} \u00b7 started by ${row.startedBy}${at}`;
}

export type RejoinPick =
  | { kind: 'rejoin'; shareCode: string; guestPass: string | null; relay?: string }
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
    dialog.appendChild(section);

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
        const chip = document.createElement('span');
        chip.className = 'pmd-home-recent-format pmd-home-session-role';
        chip.textContent = c.role === 'host' ? 'HOST' : 'JOINED';
        row.appendChild(chip);
        const name = document.createElement('span');
        name.className = 'pmd-home-recent-name';
        name.textContent = c.title || 'Collaboration session';
        name.title = name.textContent;
        row.appendChild(name);
        const meta = document.createElement('span');
        meta.className = 'pmd-home-recent-path';
        meta.textContent = describe(c);
        row.appendChild(meta);
        row.addEventListener('click', () =>
          finish({ kind: 'rejoin', shareCode: c.shareCode, guestPass: c.guestPass, ...(c.relay ? { relay: c.relay } : {}) }),
        );
        wrap.dataset['search'] = `${c.title} ${describe(c)}`.toLowerCase();
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
      dialog.appendChild(teamSection);

      const sent = new Set<string>();
      const renderTeam = (rows: TeamSessionRow[]): void => {
        teamList.innerHTML = '';
        teamSection.hidden = rows.length === 0;
        for (const r of rows) {
          const wrap = document.createElement('div');
          wrap.className = 'pmd-home-session pmd-rejoin-row';
          wrap.setAttribute('role', 'listitem');
          const info = document.createElement('div');
          info.className = 'pmd-home-session-open pmd-rejoin-team-info';
          const name = document.createElement('span');
          name.className = 'pmd-home-recent-name';
          name.textContent = r.name;
          name.title = r.name;
          info.appendChild(name);
          const meta = document.createElement('span');
          meta.className = 'pmd-home-recent-path';
          meta.textContent = teamMeta(r);
          info.appendChild(meta);
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
          wrap.dataset['search'] = `${r.name} ${teamMeta(r)}`.toLowerCase();
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
  });
}
