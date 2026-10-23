/**
 * The full-screen "working" veils for starting and joining big sessions. Split out of collab-ui.ts.
 */

import { type HostProgress } from './collab-session.js';

/** Full-screen "working…" veil for the synchronous CRDT freezes a big
 *  document forces: hosting seeds the whole doc into the CRDT (~36s
 *  measured on a 6.7MB master) and joining materializes it back
 *  (~10s). Neither can yield mid-work, so the honest thing is a
 *  painted banner before the freeze starts. The 30ms wait is what
 *  lets it PAINT — returning the cleanup so callers `finally` it
 *  (via setTimeout(0), which FIFO-orders removal after the binding's
 *  own deferred init freeze). */
export async function sessionPrepOverlay(text: string): Promise<() => void> {
  const overlay = document.createElement('div');
  overlay.className = 'pmd-bulk-overlay pmd-session-prep';
  const card = document.createElement('div');
  card.className = 'pmd-session-prep-card';
  card.textContent = text;
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  // Escape hatch: if the flow that owns the release is ever interrupted
  // between here and its finally, a modal veil must not be permanent.
  const failsafe = setTimeout(() => overlay.remove(), 120_000);
  await new Promise((r) => setTimeout(r, 30));
  return () => {
    clearTimeout(failsafe);
    overlay.remove();
  };
}

/** The Start Session progress window: what's happening, how far along, and
 *  a Cancel that works while the shared copy is built and uploaded (big
 *  documents take a while; it used to be one frozen veil). */
export async function sessionProgressOverlay(onCancel: () => void): Promise<{
  update: (p: HostProgress) => void;
  lockCancel: () => void;
  close: () => void;
}> {
  const overlay = document.createElement('div');
  overlay.className = 'pmd-bulk-overlay pmd-session-prep';
  const card = document.createElement('div');
  card.className = 'pmd-session-prep-card pmd-session-progress';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Starting the collaboration session');
  const title = document.createElement('div');
  title.className = 'pmd-session-progress-title';
  title.textContent = 'Starting the collaboration session';
  const label = document.createElement('div');
  label.className = 'pmd-session-progress-label';
  label.textContent = 'Preparing the document…';
  const track = document.createElement('div');
  track.className = 'pmd-session-progress-track';
  const fill = document.createElement('div');
  fill.className = 'pmd-session-progress-fill';
  track.appendChild(fill);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'pmd-session-progress-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    cancel.disabled = true;
    cancel.textContent = 'Cancelling…';
    onCancel();
  });
  card.append(title, label, track, cancel);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  // Escape hatch: a veil must never be permanent (big uploads can be slow,
  // so the cap is generous).
  const failsafe = setTimeout(() => overlay.remove(), 15 * 60_000);
  await new Promise((r) => setTimeout(r, 30));
  return {
    update: (p) => {
      // Build 0–70 %, package 70–75 %, upload 75–100 %.
      let frac = 0;
      if (p.phase === 'build') {
        frac = 0.7 * (p.done / Math.max(1, p.total));
        label.textContent = `Preparing the document… ${Math.floor((p.done / Math.max(1, p.total)) * 100)}%`;
      } else if (p.phase === 'package') {
        frac = 0.72;
        label.textContent = 'Packaging…';
      } else {
        frac = 0.75 + 0.25 * (p.done / Math.max(1, p.total));
        label.textContent = p.total > 1 ? `Uploading… ${p.done} of ${p.total}` : 'Uploading…';
      }
      fill.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
    },
    lockCancel: () => {
      cancel.disabled = true;
      label.textContent = 'Opening the session…';
      fill.style.width = '100%';
    },
    close: () => {
      clearTimeout(failsafe);
      overlay.remove();
    },
  };
}
