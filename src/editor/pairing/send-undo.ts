/**
 * Undo send (xtgg): a send — cards, a whole document, a session invite —
 * waits a few seconds behind a "Sending to Ana… Undo" bar before it goes
 * to the relay. Once the relay has it the recipient's Receive pill shows
 * it within a second and nothing can take it back, so the only cancel is
 * before it leaves.
 *
 * One hold per user action (a drag of three cards is one bar, not three).
 * Settings → Collaboration → "Undo window for sends" sets the seconds;
 * 0 sends at once. Bars stack bottom-centre; Undo (or Escape while the
 * bar has focus) cancels, the countdown running out sends.
 */

import { settings } from '../settings.js';
import { showToast } from '../toast.js';

const bars = new Set<HTMLElement>();

function stackEl(): HTMLElement {
  let el = document.getElementById('pmd-send-undo-stack');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pmd-send-undo-stack';
    el.className = 'pmd-send-undo-stack';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  return el;
}

/** Seconds a send waits for Undo (0 = none). */
export function sendUndoSeconds(): number {
  const s = settings.get('sendUndoSeconds');
  return typeof s === 'number' && Number.isFinite(s) ? Math.max(0, Math.min(15, s)) : 4;
}

/**
 * Show "<text>… Undo" for the undo window. Resolves true to send, false
 * when the user pressed Undo (and says "Not sent"). No window (0 seconds)
 * or no DOM: true at once.
 */
export function holdForUndo(text: string, seconds = sendUndoSeconds()): Promise<boolean> {
  if (seconds <= 0 || typeof document === 'undefined') return Promise.resolve(true);
  return new Promise((resolve) => {
    const bar = document.createElement('div');
    bar.className = 'pmd-send-undo';
    const label = document.createElement('span');
    label.className = 'pmd-send-undo-text';
    label.textContent = `${text}…`;
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'pmd-send-undo-btn';
    undo.textContent = 'Undo';
    const meter = document.createElement('span');
    meter.className = 'pmd-send-undo-meter';
    meter.style.animationDuration = `${seconds}s`;
    bar.append(label, undo, meter);

    let done = false;
    const finish = (send: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bars.delete(bar);
      bar.remove();
      if (!send) showToast('Not sent');
      resolve(send);
    };
    const timer = setTimeout(() => finish(true), seconds * 1000);
    undo.addEventListener('click', (e) => {
      e.stopPropagation();
      finish(false);
    });
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(false);
      }
    });
    bars.add(bar);
    stackEl().appendChild(bar);
  });
}
