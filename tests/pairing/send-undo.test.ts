// @vitest-environment jsdom
/**
 * Undo send (xtgg): a send waits behind a "Sending… Undo" bar; Undo
 * cancels it ("Not sent"), the countdown running out sends, 0 seconds
 * sends at once with no bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdForUndo, sendUndoSeconds } from '../../src/editor/pairing/send-undo.js';
import { settings } from '../../src/editor/settings.js';

describe('holdForUndo', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    settings.set('sendUndoSeconds', 4);
  });

  const bar = (): HTMLElement | null => document.querySelector('.pmd-send-undo');

  it('sends when the window runs out, and the bar goes away', async () => {
    const p = holdForUndo('Sending to Ana', 4);
    expect(bar()?.textContent).toContain('Sending to Ana…');
    await vi.advanceTimersByTimeAsync(3999);
    expect(bar()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(true);
    expect(bar()).toBeNull();
  });

  it('Undo cancels the send', async () => {
    const p = holdForUndo('Sending to Ana', 4);
    (document.querySelector('.pmd-send-undo-btn') as HTMLButtonElement).click();
    await expect(p).resolves.toBe(false);
    expect(bar()).toBeNull();
    // The timer firing later changes nothing.
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBe(false);
  });

  it('two sends at once get a bar each, cancelled separately', async () => {
    const a = holdForUndo('Sending to Ana', 4);
    const b = holdForUndo('Sending to Ben', 4);
    expect(document.querySelectorAll('.pmd-send-undo')).toHaveLength(2);
    (document.querySelectorAll('.pmd-send-undo-btn')[1] as HTMLButtonElement).click();
    await expect(b).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(a).resolves.toBe(true);
  });

  it('0 seconds sends at once with no bar; the setting is clamped to 0–15', async () => {
    await expect(holdForUndo('Sending to Ana', 0)).resolves.toBe(true);
    expect(bar()).toBeNull();
    settings.set('sendUndoSeconds', 0);
    expect(sendUndoSeconds()).toBe(0);
    settings.set('sendUndoSeconds', 4);
    expect(sendUndoSeconds()).toBe(4);
  });
});
