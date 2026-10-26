// @vitest-environment jsdom
/**
 * Tournament mode (BCai's build): one switch, stored in the old update
 * pause (`updateChecksPausedUntil`) so an install paused before stays
 * paused, that also silences the relay bar, relay notices and join-request
 * sounds; the timer rule the reminders use; the relay bar's offline text
 * and when it may show at all; and the join-request palette commands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => ({ posted: [] as string[], cleared: [] as string[] }));
vi.mock('../../src/editor/status-notices.js', () => ({
  postNotice: (n: { key: string }) => notices.posted.push(n.key),
  clearNotice: (k: string) => notices.cleared.push(k),
}));
const toasts = vi.hoisted(() => [] as string[]);
vi.mock('../../src/editor/toast.js', () => ({ showToast: (m: string) => toasts.push(m) }));

import {
  setTournamentMode,
  syncTournamentModeAttr,
  tournamentModeOn,
  tournamentModeUntil,
  TOURNAMENT_MODE_MS,
} from '../../src/editor/tournament-mode.js';
import { initTournamentChip, renderTournamentChip } from '../../src/editor/tournament-mode-ui.js';
import { timerQuiet, TIMER_QUIET_MS } from '../../src/editor/quiet-hours.js';
import { barWanted, outageText } from '../../src/editor/collab/relay-reachability.js';
import { syncRelayNotice, __resetRelayInfoUiForTests } from '../../src/editor/collab/relay-info-ui.js';
import {
  answerFirstJoinRequest,
  setJoinRequests,
  __resetJoinRequestsUiForTests,
} from '../../src/editor/collab/team-sessions-ui.js';
import { settings } from '../../src/editor/settings.js';
import type { RelayInfo } from '../../src/editor/collab/relay-info.js';

beforeEach(() => {
  settings.set('updateChecksPausedUntil', 0);
  settings.set('relayInfoDismissedNotices', []);
  notices.posted.length = 0;
  notices.cleared.length = 0;
  toasts.length = 0;
});

describe('the switch', () => {
  it('on for a week, in the old pause setting; off clears it', () => {
    const now = 1_800_000_000_000;
    setTournamentMode(true, now);
    expect(tournamentModeUntil()).toBe(now + TOURNAMENT_MODE_MS);
    expect(settings.get('updateChecksPausedUntil')).toBe(now + TOURNAMENT_MODE_MS);
    expect(tournamentModeOn(now + 1)).toBe(true);
    expect(tournamentModeOn(now + TOURNAMENT_MODE_MS + 1)).toBe(false); // the week runs out
    setTournamentMode(false);
    expect(tournamentModeOn()).toBe(false);
  });

  it('an install paused by an older build counts as on', () => {
    settings.set('updateChecksPausedUntil', Date.now() + 60_000);
    expect(tournamentModeOn()).toBe(true);
  });

  it('marks <html> so the update pill stops pulsing', () => {
    setTournamentMode(true);
    syncTournamentModeAttr();
    expect(document.documentElement.hasAttribute('data-tournament-mode')).toBe(true);
    setTournamentMode(false);
    syncTournamentModeAttr();
    expect(document.documentElement.hasAttribute('data-tournament-mode')).toBe(false);
  });
});

describe('the status-bar chip', () => {
  afterEach(() => vi.useRealTimers());
  it('goes back to off at the exact moment the week runs out, not up to an hour later', () => {
    vi.useFakeTimers();
    const now = Date.now();
    settings.set('updateChecksPausedUntil', now + 90_000);
    const el = document.createElement('button');
    initTournamentChip(el);
    expect(el.dataset['state']).toBe('on');
    vi.advanceTimersByTime(89_000);
    expect(el.dataset['state']).toBe('on');
    vi.advanceTimersByTime(1_100);
    expect(el.dataset['state']).toBe('off');
  });

  it('off is an icon with its name in aria-label + title; on keeps its text', () => {
    const el = document.createElement('button');
    renderTournamentChip(el);
    expect(el.textContent).toBe('');
    expect(el.querySelector('.pmd-icon-trophy')).not.toBeNull();
    expect(el.getAttribute('aria-label')).toBe('Tournament mode: off');
    expect(el.title).toMatch(/^Tournament mode: off\b/);
    setTournamentMode(true);
    renderTournamentChip(el);
    expect(el.textContent).toBe('Tournament mode on');
    expect(el.querySelector('.pmd-icon')).toBeNull();
    expect(el.hasAttribute('aria-label')).toBe(false);
  });
});

describe('the round timer keeps reminders away', () => {
  it('running, or stopped under 30 minutes ago', () => {
    const now = 10_000_000;
    expect(timerQuiet(true, 0, now)).toBe(true);
    expect(timerQuiet(false, now - 60_000, now)).toBe(true);
    expect(timerQuiet(false, now - TIMER_QUIET_MS - 1, now)).toBe(false);
    expect(timerQuiet(false, 0, now)).toBe(false);
  });
});

describe('the relay-down bar', () => {
  it('only when someone is waiting on the relay, never in tournament mode', () => {
    expect(barWanted({ inSession: false, sendFailed: false, tournamentMode: false })).toBe(false); // a failing poll alone
    expect(barWanted({ inSession: true, sendFailed: false, tournamentMode: false })).toBe(true);
    expect(barWanted({ inSession: false, sendFailed: true, tournamentMode: false })).toBe(true);
    expect(barWanted({ inSession: true, sendFailed: true, tournamentMode: true })).toBe(false);
  });
  it('offline says so instead of blaming the relay', () => {
    expect(outageText({ maintenance: false, inSession: false, offline: true })).toBe(
      'You’re offline — cards will arrive when you reconnect.',
    );
    expect(outageText({ maintenance: true, inSession: true, offline: true })).toMatch(/^You’re offline/);
  });
});

describe('relay notices', () => {
  afterEach(() => __resetRelayInfoUiForTests());
  const info: RelayInfo = {
    v: 1,
    operator: { name: 'Team relay', url: '', support: '', status: '', manage: '' },
    access: null,
    notice: { id: 'n1', text: 'Maintenance tonight', until: null },
    clients: [],
  };
  it('none in tournament mode; it comes back after', () => {
    setTournamentMode(true);
    syncRelayNotice(info);
    expect(notices.posted).toEqual([]);
    setTournamentMode(false);
    syncRelayNotice(info);
    expect(notices.posted).toEqual(['relay-notice:n1']);
  });
});

describe('join requests', () => {
  afterEach(() => {
    __resetJoinRequestsUiForTests();
    vi.unstubAllGlobals();
  });
  const req = (id: string, name: string, createdAt: number) =>
    ({ requestId: id, name, createdAt }) as unknown as Parameters<typeof setJoinRequests>[1][number];

  it('the palette answers the oldest request', async () => {
    const approve = vi.fn(async () => {});
    const deny = vi.fn(async () => {});
    setJoinRequests('room', [req('b', 'Bo', 2), req('a', 'Al', 1)], { approve, deny, sessionName: () => 'Aff K' });
    const card = document.getElementById('team-join-requests')!;
    expect(card.getAttribute('aria-label')).toBe('Join request from Al');
    expect([...card.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Approve Al', 'Deny Al']);
    answerFirstJoinRequest('approve');
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'a' }));
    await Promise.resolve();
    await Promise.resolve();
    answerFirstJoinRequest('deny');
    expect(deny).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'b' }));
  });

  it('says so when nobody is asking', () => {
    answerFirstJoinRequest('approve');
    expect(toasts).toEqual(['No one is asking to join right now.']);
  });

  it('the desktop notification is silent in tournament mode', () => {
    const made: Array<{ silent?: boolean }> = [];
    vi.stubGlobal(
      'Notification',
      class {
        constructor(_t: string, o: { silent?: boolean }) {
          made.push(o);
        }
      },
    );
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const handlers = { approve: async () => {}, deny: async () => {}, sessionName: () => '' };
    setJoinRequests('room', [req('x', 'Cy', 1)], handlers);
    setTournamentMode(true);
    setJoinRequests('room', [req('x', 'Cy', 1), req('y', 'Di', 2)], handlers);
    expect(made.map((o) => o.silent)).toEqual([false, true]);
  });
});
