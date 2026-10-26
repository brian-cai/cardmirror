// @vitest-environment jsdom
/**
 * Weekly update reminder (xtgg): a pending update gets one dialog on
 * Wednesday, never on other days, never twice the same Wednesday, and not
 * during the tournament pause or a live co-editing session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initUpdateNudge, localDayKey, nudgeText, shouldNudge } from '../../src/editor/update-nudge.js';
import type { UpdateChipHost, UpdateChipState } from '../../src/editor/update-chip.js';

const WED = new Date(2026, 9, 28, 10, 0); // Wednesday, Oct 28 2026
const THU = new Date(2026, 9, 29, 10, 0);
const READY: UpdateChipState = { state: 'ready', version: '1.15.40' };
const base = { now: WED, state: READY, lastDay: null, paused: false, sessionLive: false };

describe('shouldNudge', () => {
  it('reminds on a Wednesday with an update pending', () => {
    expect(WED.getDay()).toBe(3);
    expect(shouldNudge(base)).toBe(true);
  });
  it('not on other days', () => {
    expect(shouldNudge({ ...base, now: THU })).toBe(false);
  });
  it('not without a pending update', () => {
    expect(shouldNudge({ ...base, state: null })).toBe(false);
  });
  it('once per Wednesday, again the next week', () => {
    expect(shouldNudge({ ...base, lastDay: localDayKey(WED) })).toBe(false);
    const nextWed = new Date(2026, 10, 4, 9, 0);
    expect(shouldNudge({ ...base, now: nextWed, lastDay: localDayKey(WED) })).toBe(true);
  });
  it('not during the tournament pause or a live session', () => {
    expect(shouldNudge({ ...base, paused: true })).toBe(false);
    expect(shouldNudge({ ...base, sessionLive: true })).toBe(false);
  });
  it('not while the round timer runs or ran in the last 30 minutes', () => {
    expect(shouldNudge({ ...base, timerBusy: true })).toBe(false);
    expect(shouldNudge({ ...base, timerBusy: false })).toBe(true);
  });
});

describe('nudgeText', () => {
  it('restart for a staged update, download page otherwise', () => {
    expect(nudgeText(READY).okLabel).toBe('Restart and update');
    expect(nudgeText({ state: 'available', version: '1.15.40' }).okLabel).toBe('Get the update');
  });
});

describe('initUpdateNudge', () => {
  // Node's own (unconfigured) localStorage global shadows jsdom's here: give
  // each test a fresh in-memory one.
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());

  function host(initial: UpdateChipState | null): UpdateChipHost & { actions: number } {
    const h = {
      actions: 0,
      getUpdateChipState: () => Promise.resolve(initial),
      updateChipAction: () => {
        h.actions++;
        return Promise.resolve();
      },
      onUpdateChip: () => () => {},
    };
    return h;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('shows one dialog and installs on OK; a second window does not ask again', async () => {
    const h = host(READY);
    let asked = 0;
    const deps = { paused: () => false, sessionLive: () => false, now: () => WED,
      confirm: () => { asked++; return Promise.resolve(true); } };
    const stop1 = initUpdateNudge(h, deps);
    await flush(); await flush();
    const stop2 = initUpdateNudge(h, deps);
    await flush(); await flush();
    stop1(); stop2();
    expect(asked).toBe(1);
    expect(h.actions).toBe(1);
  });

  it('Later does nothing', async () => {
    const h = host(READY);
    const stop = initUpdateNudge(h, { paused: () => false, sessionLive: () => false, now: () => WED,
      confirm: () => Promise.resolve(false) });
    await flush(); await flush();
    stop();
    expect(h.actions).toBe(0);
  });

  it('opens as an unsolicited dialog (Later focused, keys guarded)', async () => {
    const h = host(READY);
    const seen: Array<{ unsolicited: boolean; cancelLabel: string }> = [];
    const stop = initUpdateNudge(h, { paused: () => false, sessionLive: () => false, now: () => WED,
      confirm: (_m, o) => { seen.push(o); return Promise.resolve(false); } });
    await flush(); await flush();
    stop();
    expect(seen).toEqual([expect.objectContaining({ unsolicited: true, cancelLabel: 'Later' })]);
  });

  it('waits while a session is live in another window, or the timer is busy', async () => {
    const h = host(READY);
    let asked = 0;
    const stop = initUpdateNudge(h, { paused: () => false, sessionLive: async () => true, now: () => WED,
      confirm: () => { asked++; return Promise.resolve(true); } });
    await flush(); await flush();
    stop();
    const stop2 = initUpdateNudge(h, { paused: () => false, sessionLive: () => false, timerBusy: () => true, now: () => WED,
      confirm: () => { asked++; return Promise.resolve(true); } });
    await flush(); await flush();
    stop2();
    expect(asked).toBe(0);
    expect(localStorage.getItem('cm.updateNudge.lastDay')).toBeNull(); // still owed today
  });
});
