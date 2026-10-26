// @vitest-environment jsdom
/**
 * In-editor confirm dialog (`showConfirm`) — the window.confirm replacement for
 * transclusion create/update prompts. It renders through `confirmDialog`, so
 * every yes/no question in the app looks the same (one dialog style).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showConfirm } from '../../src/editor/confirm-dialog.js';
import { confirmDialog, promptForText, UNSOLICITED_KEY_GUARD_MS } from '../../src/editor/text-prompt.js';

const okBtn = (): HTMLButtonElement | null => document.querySelector('.pmd-route-dialog .pmd-text-prompt-ok');
const cancelBtn = (): HTMLButtonElement | null => document.querySelector('.pmd-route-dialog .pmd-route-cancel');
const key = (k: string, target: EventTarget = document.body): KeyboardEvent => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe('showConfirm', () => {
  it('resolves true when the confirm button is clicked, and cleans up', async () => {
    const p = showConfirm({ message: 'Proceed?', confirmLabel: 'Yes' });
    expect(okBtn()?.textContent).toBe('Yes');
    okBtn()!.click();
    expect(await p).toBe(true);
    expect(document.querySelector('.pmd-route-overlay')).toBeNull();
  });

  it('resolves false when cancel is clicked', async () => {
    const p = showConfirm({ message: 'Proceed?' });
    cancelBtn()!.click();
    expect(await p).toBe(false);
  });

  it('resolves false on Escape', async () => {
    const p = showConfirm({ message: 'Proceed?' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(await p).toBe(false);
  });

  it('uses the shared dialog style: title, message, and a danger action', async () => {
    const p = showConfirm({ title: 'Heads up', message: 'Body', danger: true });
    expect(document.querySelector('.pmd-confirm')).toBeNull(); // the old second style is gone
    expect(document.querySelector('.pmd-route-dialog .pmd-route-header')?.textContent).toBe('Heads up');
    expect(document.querySelector('.pmd-route-dialog .pmd-choice-prompt-detail')?.textContent).toBe('Body');
    expect(okBtn()?.classList.contains('pmd-text-prompt-danger')).toBe(true);
    cancelBtn()!.click();
    await p;
  });
});

describe('unsolicited dialogs (reminders, invite links)', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('focuses Cancel, and ignores keys for the first second', async () => {
    vi.useFakeTimers();
    let settled: boolean | null = null;
    void confirmDialog('Restart now?', { title: 'Update', okLabel: 'Restart', cancelLabel: 'Later', unsolicited: true }).then(
      (v) => (settled = v),
    );
    expect(document.activeElement).toBe(cancelBtn());
    // Typing that was meant for the editor: Enter and letters do nothing.
    expect(key('Enter', okBtn()!).defaultPrevented).toBe(true);
    expect(key('a').defaultPrevented).toBe(true);
    await Promise.resolve();
    expect(settled).toBeNull();
    vi.advanceTimersByTime(UNSOLICITED_KEY_GUARD_MS + 10);
    // After the guard, Enter on the focused Cancel is the button's own click
    // (not prevented), never a confirm.
    expect(key('Enter', cancelBtn()!).defaultPrevented).toBe(false);
    expect(settled).toBeNull();
    // Enter with focus outside the buttons does nothing either.
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(settled).toBeNull();
    cancelBtn()!.click();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('Escape cancels even during the guard', async () => {
    const p = confirmDialog('Restart now?', { unsolicited: true });
    key('Escape');
    await expect(p).resolves.toBe(false);
  });

  it('a field is never focused on open; Enter inside it confirms', async () => {
    vi.useFakeTimers();
    let name = '';
    const p = showConfirm({
      message: 'Connect?',
      unsolicited: true,
      field: { label: 'Your name', onInput: (v) => (name = v) },
    });
    const input = document.querySelector<HTMLInputElement>('.pmd-route-dialog input')!;
    expect(document.activeElement).not.toBe(input);
    vi.advanceTimersByTime(UNSOLICITED_KEY_GUARD_MS + 10);
    input.value = 'Ana';
    input.dispatchEvent(new Event('input'));
    key('Enter', input);
    await expect(p).resolves.toBe(true);
    expect(name).toBe('Ana');
  });

  it('a user-asked confirm still takes Enter as OK', async () => {
    const p = confirmDialog('Switch?');
    key('Enter');
    await expect(p).resolves.toBe(true);
  });

  it('promptForText unsolicited keeps the caret out of the field', async () => {
    const p = promptForText({ message: 'Name?', cancelLabel: 'Not now', unsolicited: true });
    await new Promise((r) => setTimeout(r, 0));
    const input = document.querySelector<HTMLInputElement>('.pmd-text-prompt-input')!;
    expect(document.activeElement).not.toBe(input);
    expect(document.activeElement?.textContent).toBe('Not now');
    key('Escape');
    await expect(p).resolves.toBeNull();
  });
});
