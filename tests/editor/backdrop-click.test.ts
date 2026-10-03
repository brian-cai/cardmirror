// @vitest-environment jsdom
/**
 * Modal backdrops close on a click that starts AND ends on the backdrop,
 * not on the drag-release a text selection produces: press inside the
 * dialog (a field), release over the backdrop, and the browser fires a
 * `click` whose target is the backdrop.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isBackdropClick } from '../../src/editor/backdrop-click.js';
import { promptForText } from '../../src/editor/text-prompt.js';

afterEach(() => {
  document.body.innerHTML = '';
});

function press(target: Element): void {
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, detail: 1 }));
}
function releaseClick(target: Element): MouseEvent {
  const e = new MouseEvent('click', { bubbles: true, detail: 1 });
  target.dispatchEvent(e);
  return e;
}

describe('isBackdropClick', () => {
  const setup = () => {
    const backdrop = document.createElement('div');
    const dialog = document.createElement('div');
    const field = document.createElement('input');
    dialog.appendChild(field);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    return { backdrop, field };
  };

  it('a press and release on the backdrop is a backdrop click', () => {
    const { backdrop } = setup();
    let hit = false;
    backdrop.addEventListener('click', (e) => (hit = isBackdropClick(e, backdrop)));
    press(backdrop);
    releaseClick(backdrop);
    expect(hit).toBe(true);
  });

  it('a selection dragged out of a field and released on the backdrop is not', () => {
    const { backdrop, field } = setup();
    let hit = true;
    backdrop.addEventListener('click', (e) => (hit = isBackdropClick(e, backdrop)));
    press(field);
    releaseClick(backdrop); // the browser targets the common ancestor
    expect(hit).toBe(false);
  });

  it('a click with no press behind it (keyboard, element.click()) only needs the target', () => {
    const { backdrop } = setup();
    let hit = false;
    backdrop.addEventListener('click', (e) => (hit = isBackdropClick(e, backdrop)));
    backdrop.click();
    expect(hit).toBe(true);
  });
});

describe('a real dialog (the text prompt)', () => {
  it('stays open when a selection drag in its field ends on the backdrop; a real backdrop click cancels', async () => {
    const pending = promptForText({ message: 'Relay URL' });
    const input = document.querySelector('.pmd-text-prompt-input') as HTMLInputElement;
    const overlay = input.closest('.pmd-route-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    press(input);
    releaseClick(overlay);
    expect(overlay.isConnected).toBe(true);
    press(overlay);
    releaseClick(overlay);
    expect(overlay.isConnected).toBe(false);
    expect(await pending).toBeNull();
  });
});
