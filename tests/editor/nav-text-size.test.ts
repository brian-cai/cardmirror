// @vitest-environment jsdom
/** Nav pane text size changed in place: ⌘/Ctrl+wheel over the nav pane. */
import { describe, it, expect, beforeEach } from 'vitest';
import { settings } from '../../src/editor/settings.js';
import { handleNavWheel, isInNav } from '../../src/editor/nav-text-size.js';

function wheel(target: Element, deltaY: number, mods: { ctrlKey?: boolean; metaKey?: boolean }): WheelEvent {
  const e = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true, ...mods });
  Object.defineProperty(e, 'target', { value: target });
  return e;
}

describe('⌘/Ctrl+wheel over the nav pane', () => {
  let nav: HTMLElement;
  let row: HTMLElement;
  let editor: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = '';
    nav = document.createElement('div');
    nav.className = 'pmd-nav-panel';
    row = document.createElement('li');
    nav.appendChild(row);
    editor = document.createElement('div');
    document.body.append(nav, editor);
    settings.set('navTextScale', 100);
  });

  it('resizes the nav text, one 5% step per notch, and claims the event', () => {
    const up = wheel(row, -80, { metaKey: true });
    expect(handleNavWheel(up)).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(settings.get('navTextScale')).toBe(110);
    handleNavWheel(wheel(row, 40, { ctrlKey: true }));
    expect(settings.get('navTextScale')).toBe(105);
  });

  it('leaves plain scrolling and the document alone', () => {
    expect(handleNavWheel(wheel(row, -100, {}))).toBe(false);
    expect(handleNavWheel(wheel(editor, -100, { metaKey: true }))).toBe(false);
    expect(settings.get('navTextScale')).toBe(100);
    expect(isInNav(row)).toBe(true);
    expect(isInNav(editor)).toBe(false);
  });
});
