/**
 * "Find Unformatted Cites" — review the cites `findUnmarkedCites` proposes,
 * tick the ones that are right, and format them all as cites (F8) in one
 * step (one undo).
 */
import type { EditorView } from 'prosemirror-view';
import { pushOverlay, popOverlay } from './overlay-stack.js';
import { installModalKeys, captureFocusForDialog } from './text-prompt.js';
import { showToast } from './toast.js';
import { applyCiteCandidates, findUnmarkedCites, type CiteCandidate } from './cite-finder.js';

/** How much of the paragraph to show after the proposed span. */
const TAIL_CHARS = 90;

export function openCiteFinder(view: EditorView): void {
  const found = findUnmarkedCites(view.state.doc);
  if (found.length === 0) {
    showToast('No unformatted cites found: every card either has cite formatting or doesn’t open with an author and year.');
    return;
  }
  if (typeof document === 'undefined') return;

  const backdrop = document.createElement('div');
  backdrop.className = 'pmd-confirm-backdrop';
  const dialog = document.createElement('div');
  dialog.className = 'pmd-confirm pmd-cite-finder';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Unformatted cites');

  const title = document.createElement('div');
  title.className = 'pmd-confirm-title';
  title.textContent = `${found.length} unformatted cite${found.length === 1 ? '' : 's'}`;
  const message = document.createElement('div');
  message.className = 'pmd-confirm-message';
  message.textContent =
    'These cards have no cite formatting, so read mode hides who wrote them. ' +
    'The bold part of each line would be formatted as the cite (F8). Untick any that are wrong.';

  const tools = document.createElement('div');
  tools.className = 'pmd-cite-finder-tools';
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'pmd-confirm-btn pmd-confirm-cancel';
  allBtn.textContent = 'Select all';
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'pmd-confirm-btn pmd-confirm-cancel';
  noneBtn.textContent = 'Select none';
  tools.append(allBtn, noneBtn);

  const list = document.createElement('ul');
  list.className = 'pmd-cite-finder-list';
  const boxes: { box: HTMLInputElement; c: CiteCandidate }[] = [];
  for (const c of found) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    const text = document.createElement('div');
    text.className = 'pmd-cite-finder-text';
    const tagEl = document.createElement('div');
    tagEl.className = 'pmd-cite-finder-tag';
    tagEl.textContent = c.tag || '(untitled card)';
    const line = document.createElement('div');
    line.className = 'pmd-cite-finder-line';
    const strong = document.createElement('strong');
    strong.textContent = c.spanText;
    const rest = c.paraText.slice(c.spanStart + c.spanText.length);
    line.append(
      strong,
      document.createTextNode(rest.length > TAIL_CHARS ? `${rest.slice(0, TAIL_CHARS)}…` : rest),
    );
    text.append(tagEl, line);
    label.append(box, text);
    li.appendChild(label);
    list.appendChild(li);
    boxes.push({ box, c });
  }

  const actions = document.createElement('div');
  actions.className = 'pmd-confirm-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'pmd-confirm-btn pmd-confirm-cancel';
  cancelBtn.textContent = 'Cancel';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'pmd-confirm-btn pmd-confirm-ok';
  actions.append(cancelBtn, okBtn);

  const refreshCount = (): void => {
    const n = boxes.filter((b) => b.box.checked).length;
    okBtn.textContent = n === 1 ? 'Format 1 cite' : `Format ${n} cites`;
    okBtn.disabled = n === 0;
  };
  list.addEventListener('change', refreshCount);
  allBtn.addEventListener('click', () => {
    for (const b of boxes) b.box.checked = true;
    refreshCount();
  });
  noneBtn.addEventListener('click', () => {
    for (const b of boxes) b.box.checked = false;
    refreshCount();
  });
  refreshCount();

  dialog.append(title, message, tools, list, actions);
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);

  const overlayToken = pushOverlay();
  const restoreFocus = captureFocusForDialog();
  let removeKeys = (): void => {};
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    removeKeys();
    popOverlay(overlayToken);
    backdrop.remove();
    restoreFocus();
  };
  const apply = (): void => {
    const picked = boxes.filter((b) => b.box.checked).map((b) => b.c);
    close();
    if (picked.length === 0) return;
    const tr = view.state.tr;
    const n = applyCiteCandidates(tr, picked);
    if (n > 0) view.dispatch(tr);
    const skipped = picked.length - n;
    showToast(
      `Formatted ${n} cite${n === 1 ? '' : 's'}` +
        (skipped > 0 ? ` (${skipped} skipped: the document changed)` : '') +
        '. Undo reverts them all.',
    );
  };
  removeKeys = installModalKeys(dialog, overlayToken, (e) => {
    if (e.key === 'Escape') {
      close();
      return true;
    }
    if (e.key === 'Enter' && !okBtn.disabled) {
      apply();
      return true;
    }
    return false;
  });
  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', apply);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  setTimeout(() => okBtn.focus(), 0);
}
