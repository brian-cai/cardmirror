// @vitest-environment jsdom
/**
 * Daily display-name reminder (xtgg): a computer with no display name is
 * asked once a day, never once it has a name or the user ticked "Don't ask
 * again", and not during the tournament pause, a live session, or over
 * another dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initNameNudge, shouldAskName } from '../../src/editor/name-nudge.js';
import { localDayKey } from '../../src/editor/update-nudge.js';

const MON = new Date(2026, 9, 26, 10, 0);
const TUE = new Date(2026, 9, 27, 10, 0);
const base = { now: MON, name: '', lastDay: null, never: false, paused: false, sessionLive: false, overlayOpen: false };

describe('shouldAskName', () => {
  it('asks when the name is empty', () => {
    expect(shouldAskName(base)).toBe(true);
    expect(shouldAskName({ ...base, name: '   ' })).toBe(true);
  });
  it('not once there is a name', () => {
    expect(shouldAskName({ ...base, name: 'Ana Lopez' })).toBe(false);
  });
  it('once a day, again the next day', () => {
    expect(shouldAskName({ ...base, lastDay: localDayKey(MON) })).toBe(false);
    expect(shouldAskName({ ...base, now: TUE, lastDay: localDayKey(MON) })).toBe(true);
  });
  it('never after "Don’t ask again"', () => {
    expect(shouldAskName({ ...base, never: true })).toBe(false);
  });
  it('not during the pause, a live session, or another dialog', () => {
    expect(shouldAskName({ ...base, paused: true })).toBe(false);
    expect(shouldAskName({ ...base, sessionLive: true })).toBe(false);
    expect(shouldAskName({ ...base, overlayOpen: true })).toBe(false);
  });
});

describe('initNameNudge', () => {
  // Node's own (unconfigured) localStorage global shadows jsdom's here: give
  // the module a plain in-memory one.
  const m = new Map<string, string>();
  beforeEach(() => {
    m.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      clear: () => m.clear(),
    });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(answer: string | null, tick = false) {
    let name = '';
    const prompt = vi.fn(async (opts: { checkbox: { onChange: (c: boolean) => void } }) => {
      if (tick) opts.checkbox.onChange(true);
      return answer;
    });
    const stop = initNameNudge({
      name: () => name,
      setName: (n) => (name = n),
      paused: () => false,
      sessionLive: () => false,
      overlayOpen: () => false,
      prompt,
      now: () => MON,
    });
    return { prompt, stop, name: () => name };
  }

  it('saves the typed name, and asks once per day', async () => {
    const s = setup(' Ana Lopez ');
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.prompt).toHaveBeenCalledTimes(1);
    expect(s.name()).toBe('Ana Lopez');
    window.dispatchEvent(new Event('focus'));
    expect(s.prompt).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('"Not now" asks again tomorrow; "Don’t ask again" never does', async () => {
    const s = setup(null);
    await vi.advanceTimersByTimeAsync(5000);
    s.stop();
    expect(localStorage.getItem('cm.nameNudge.never')).toBeNull();
    expect(localStorage.getItem('cm.nameNudge.lastDay')).toBe(localDayKey(MON));

    localStorage.clear();
    const t = setup(null, true);
    await vi.advanceTimersByTimeAsync(5000);
    t.stop();
    expect(localStorage.getItem('cm.nameNudge.never')).toBe('1');
  });
});
