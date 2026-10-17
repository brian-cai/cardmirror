/**
 * scheduleIdle with a finite delay is a real debounce: the work waits the
 * quiet period (re-armed by cancel + reschedule), then for an idle frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelIdle, scheduleIdle } from '../../src/editor/idle-scheduler.js';

describe('scheduleIdle', () => {
  let idleCbs: Array<() => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    idleCbs = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idleCbs.push(cb));
    vi.stubGlobal('cancelIdleCallback', (id: number) => {
      idleCbs[id - 1] = () => {};
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits the delay before asking for an idle frame', () => {
    const fn = vi.fn();
    scheduleIdle(fn, 200);
    vi.advanceTimersByTime(199);
    expect(idleCbs).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(idleCbs).toHaveLength(1);
    idleCbs[0]!();
    expect(fn).toHaveBeenCalledOnce();
  });

  it('cancel + reschedule during typing never runs the work', () => {
    const fn = vi.fn();
    let h = scheduleIdle(fn, 200);
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      cancelIdle(h);
      h = scheduleIdle(fn, 200);
    }
    expect(idleCbs).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(idleCbs).toHaveLength(1);
  });

  it('Infinity asks for an idle frame right away, with no cap', () => {
    const fn = vi.fn();
    scheduleIdle(fn, Infinity);
    expect(idleCbs).toHaveLength(1);
  });
});
