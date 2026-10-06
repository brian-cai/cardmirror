/** Window sleep policy (apps/desktop/src/window-sleep.ts). */
import { describe, it, expect } from 'vitest';
import { pickWindowsToSleep, sanitizeSleepMinutes, type SleepCandidate } from '../../apps/desktop/src/window-sleep.js';

const MIN = 60_000;
const now = 10_000 * MIN;
const w = (over: Partial<SleepCandidate> & { id: number }): SleepCandidate => ({
  phase: 'awake',
  focused: false,
  lastActiveAt: now - 20 * MIN,
  exempt: false,
  ...over,
});

describe('pickWindowsToSleep', () => {
  it('sleeps unfocused windows idle at least the threshold', () => {
    expect(pickWindowsToSleep([w({ id: 1 }), w({ id: 2, lastActiveAt: now - 14 * MIN })], now, 15)).toEqual([1]);
  });
  it('never the focused window, an exempt one, or one already resting / asked / waking', () => {
    const picked = pickWindowsToSleep(
      [
        w({ id: 1, focused: true }),
        w({ id: 2, exempt: true }),
        w({ id: 3, phase: 'asleep' }),
        w({ id: 4, phase: 'requesting' }),
        w({ id: 5, phase: 'waking' }),
        w({ id: 6 }),
      ],
      now,
      15,
    );
    expect(picked).toEqual([6]);
  });
  it('0 minutes (or nonsense) turns sleep off', () => {
    expect(pickWindowsToSleep([w({ id: 1 })], now, 0)).toEqual([]);
    expect(pickWindowsToSleep([w({ id: 1 })], now, Number.NaN)).toEqual([]);
  });
});

describe('sanitizeSleepMinutes', () => {
  it('rounds, clamps to 0–1440, and defaults to 15', () => {
    expect(sanitizeSleepMinutes(14.6)).toBe(15);
    expect(sanitizeSleepMinutes(-3)).toBe(0);
    expect(sanitizeSleepMinutes(99999)).toBe(1440);
    expect(sanitizeSleepMinutes('x')).toBe(15);
  });
});
