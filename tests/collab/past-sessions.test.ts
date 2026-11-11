// @vitest-environment jsdom
/**
 * Join dialog → Past sessions: every session this machine kept history
 * for shows, with its name first and who started it next; ended rooms
 * (no longer rejoinable) open a copy from their history.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  fileLine,
  namesLine,
  pickSessionToJoin,
  usedRange,
  withSessionHistory,
  type RejoinCandidate,
} from '../../src/editor/collab/rejoin-picker.js';
import { sessionInfo } from '../../src/editor/collab/collab-history.js';
import type { HistoryMeta } from '../../src/editor/host/types.js';

const meta = (roomId: string, over: Partial<HistoryMeta> = {}): HistoryMeta => ({
  roomId,
  docTitle: `Session ${roomId}`,
  startedAt: Date.now() - 3_600_000,
  updatedAt: Date.now() - 60_000,
  sizeBytes: 10,
  ...over,
});

const cand = (roomId: string): RejoinCandidate => ({
  roomId,
  shareCode: `code-${roomId}`,
  guestPass: null,
  role: 'participant',
  title: `Doc ${roomId}`,
  kind: 'left',
  at: Date.now(),
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('withSessionHistory', () => {
  it('lists history not rejoinable or live as past, newest first; rejoinable rows get details', () => {
    const history = [
      meta('old', { updatedAt: 1000 }),
      meta('a', { info: { startedBy: 'Sam', people: ['Sam', 'Jo'] } }),
      meta('new', { updatedAt: Date.now() }),
      meta('live'),
    ];
    const { candidates, past } = withSessionHistory([cand('a')], history, (id) => id === 'live');
    expect(past.map((p) => p.roomId)).toEqual(['new', 'old']);
    expect(candidates[0]!.details?.startedBy).toBe('Sam');
    expect(candidates[0]!.details?.people).toEqual(['Sam', 'Jo']);
  });
});

describe('row text', () => {
  it('names, times and the file read plainly', () => {
    expect(namesLine(['A', 'B'])).toBe('A and B');
    expect(namesLine(['A', 'B', 'C', 'D', 'E', 'F'])).toBe('A, B, C, D and 2 others');
    expect(fileLine({ fileName: 'Aff.cmir', savedAt: null })).toBe('Aff.cmir · not saved');
    expect(fileLine({ fileName: 'Untitled', savedAt: null })).toBe('not saved to a file');
    expect(fileLine({ fileName: 'Aff.cmir', savedAt: Date.now() })).toMatch(/^Aff\.cmir · saved /);
    const from = new Date(2026, 10, 9, 15, 10).getTime();
    expect(usedRange(from, from + 2 * 3_600_000)).toBe('Nov 9, 3:10 PM – 5:10 PM');
  });
});

describe('Past sessions section', () => {
  it('shows the name, then who started it, and Open a copy resolves with the room', async () => {
    const { past } = withSessionHistory(
      [],
      [meta('r1', { docTitle: 'Round 3 aff', info: { role: 'participant', startedBy: 'Sam', people: ['Brian', 'Sam'], fileName: 'R3.cmir' } })],
      () => false,
    );
    const pending = pickSessionToJoin([], undefined, past);
    const section = document.querySelector('.pmd-rejoin-past')!;
    expect(section.querySelector('.pmd-rejoin-heading')!.textContent).toBe('Past sessions');
    const lines = [...section.querySelectorAll('.pmd-rejoin-card > span')].map((e) => e.textContent);
    expect(lines[0]).toContain('Round 3 aff');
    expect(lines[1]).toBe('Started by Sam');
    expect(lines[2]).toBe('With Brian and Sam');
    expect(lines[3]).toContain('R3.cmir');
    section.querySelector<HTMLButtonElement>('.pmd-rejoin-team-btn')!.click();
    await expect(pending).resolves.toEqual({ kind: 'history', roomId: 'r1', title: 'Round 3 aff' });
  });

  it('the search box finds a past session by who started it', () => {
    const { past } = withSessionHistory(
      [],
      [meta('r1', { info: { startedBy: 'Sam' } }), meta('r2', { info: { startedBy: 'Kim' } })],
      () => false,
    );
    void pickSessionToJoin([], undefined, past);
    const input = document.querySelector<HTMLInputElement>('.pmd-rejoin-input')!;
    input.value = 'kim';
    input.dispatchEvent(new Event('input'));
    const shown = [...document.querySelectorAll<HTMLElement>('.pmd-rejoin-past .pmd-rejoin-row')].filter((r) => !r.hidden);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.textContent).toContain('Started by Kim');
  });
});

describe('sessionInfo', () => {
  const noSeed = (): string | null => null;
  it('a host is the starter; names accumulate across writes and the earlier file', () => {
    const names = new Map<string, string>();
    const first = sessionInfo(
      { role: 'host', selfName: 'Brian', present: [{ peer: '1', name: 'Brian' }, { peer: '2', name: 'Sam' }], fileName: 'Aff.cmir' },
      names,
      noSeed,
      { people: ['Jo'] },
    );
    expect(first.startedBy).toBe('Brian');
    const later = sessionInfo({ role: 'host', selfName: 'Brian', present: [{ peer: '1', name: 'Brian' }] }, names, noSeed, first);
    expect(later.people).toEqual(['Jo', 'Brian', 'Sam']);
    expect(later.fileName).toBe('Aff.cmir');
  });

  it('a joiner takes the published starter, else the seeding peer’s name', () => {
    const names = new Map<string, string>();
    expect(sessionInfo({ role: 'participant', selfName: 'Brian', startedBy: 'Sam', present: [] }, names, noSeed).startedBy).toBe('Sam');
    const viaSeed = sessionInfo(
      { role: 'participant', selfName: 'Brian', present: [{ peer: '9', name: 'Kim' }] },
      new Map(),
      () => '9',
    );
    expect(viaSeed.startedBy).toBe('Kim');
  });
});
