/**
 * "+ Add a relay…" under Saved relays: one dialog that takes a coach's
 * invite link (or, behind "Enter address and token instead", a relay
 * address and token), checks that relay with that token only, and saves it
 * WITHOUT switching — or saves it and switches the way the row's Use
 * button does. The Custom relay URL / token fields stay the relay in use;
 * nothing here types over them. Logic: relay-add.ts (reading, checking)
 * and relay-profiles.ts (addRelayPlan / addSavedRelay).
 *
 * The user opened it (a click), so keys behave normally: the field has the
 * focus, Enter checks, then Enter saves; Escape cancels.
 */

import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { isBackdropClick } from '../backdrop-click.js';
import { armDialogFocus, captureFocusForDialog, installModalKeys } from '../text-prompt.js';
import { getElectronHost } from '../host/index.js';
import { showToast } from '../toast.js';
import { addRelayPlan, addSavedRelay, currentRelayLabel, relayHostPath, type AddRelayPlan } from './relay-profiles.js';
import { checkNewRelay, checkSummary, readAddRelayInput, type RelayCandidate, type RelayCheckResult } from './relay-add.js';
import { switchRelayNow } from './relay-profiles-ui.js';

type Checked = { link: RelayCandidate; result: Extract<RelayCheckResult, { ok: true }>; plan: AddRelayPlan };

/** What the plan means, in a line under the check result. */
function planNote(plan: AddRelayPlan): string {
  switch (plan.kind) {
    case 'new':
      return 'Save keeps you on the relay you use now; switch any time from Saved relays.';
    case 'update':
      return `Already saved as ${plan.profile.label || relayHostPath(plan.profile.url)}: saving updates its token.`;
    case 'exists':
      return `Already saved as ${plan.profile.label || relayHostPath(plan.profile.url)}.`;
    case 'current':
      return 'This is the relay you’re using now.';
    case 'current-update':
      return 'This is the relay you’re using now, with a new token: saving moves it to the new token.';
    case 'full':
      return 'You have the most saved relays CardMirror keeps. Remove one first.';
  }
}

const field = (labelText: string, input: HTMLInputElement): HTMLLabelElement => {
  const label = document.createElement('label');
  label.className = 'pmd-text-prompt-field';
  const caption = document.createElement('span');
  caption.className = 'pmd-text-prompt-field-label';
  caption.textContent = labelText;
  label.append(caption, input);
  return label;
};

const textInput = (placeholder: string, password = false): HTMLInputElement => {
  const i = document.createElement('input');
  i.type = password ? 'password' : 'text';
  i.className = 'pmd-text-prompt-input';
  i.placeholder = placeholder;
  i.autocomplete = 'off';
  i.spellcheck = false;
  return i;
};

let open = false;

/** Open the dialog. Resolves when it closes. */
export function openAddRelayDialog(): Promise<void> {
  if (open) return Promise.resolve();
  open = true;
  return new Promise((resolve) => {
    const restoreFocus = captureFocusForDialog();
    const overlayToken = pushOverlay();
    const overlay = document.createElement('div');
    overlay.className = 'pmd-route-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'pmd-route-dialog pmd-text-prompt-dialog pmd-add-relay-dialog';

    const header = document.createElement('div');
    header.className = 'pmd-route-header';
    header.textContent = 'Add a relay';
    const detail = document.createElement('div');
    detail.className = 'pmd-text-prompt-detail';
    detail.textContent =
      'Paste the invite link for the relay. It’s checked and added to Saved relays; the relay you use now stays in use until you switch.';

    const invite = textInput('https://extinction.gg/relay/join#…');
    const inviteField = field('Invite link', invite);
    const url = textInput('https://relay.example.com/relay');
    const token = textInput('The relay’s token', true);
    const manual = document.createElement('div');
    manual.className = 'pmd-add-relay-manual';
    manual.append(field('Relay address', url), field('Relay token', token));
    manual.hidden = true;

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pmd-add-relay-toggle';
    toggle.textContent = 'Enter address and token instead';

    const status = document.createElement('div');
    status.className = 'pmd-text-prompt-detail pmd-add-relay-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;

    const buttons = document.createElement('div');
    buttons.className = 'pmd-text-prompt-buttons';
    const mk = (text: string, cls: string, run: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = text;
      b.addEventListener('click', run);
      return b;
    };

    let settled = false;
    let removeKeys = (): void => {};
    const close = (): void => {
      if (settled) return;
      settled = true;
      open = false;
      popOverlay(overlayToken);
      overlay.remove();
      removeKeys();
      restoreFocus();
      resolve();
    };

    let checked: Checked | null = null;
    let seq = 0;
    const cancelBtn = mk('Cancel', 'pmd-route-cancel', close);
    const useBtn = mk('Save and use now', 'pmd-route-cancel', () => void save(true));
    const checkBtn = mk('Check', 'pmd-text-prompt-ok', () => void runCheck());
    const saveBtn = mk('Save', 'pmd-text-prompt-ok', () => void save(false));
    buttons.append(cancelBtn, useBtn, checkBtn, saveBtn);

    const manualMode = (): boolean => !manual.hidden;
    const say = (text: string, kind: 'ok' | 'error' | 'busy'): void => {
      status.hidden = !text;
      status.textContent = text;
      status.dataset['kind'] = kind;
    };

    /** Show the buttons for the current state. */
    const layout = (): void => {
      const plan = checked?.plan.kind;
      checkBtn.hidden = !!checked;
      // Save: anything that changes the list. Use now: a relay not in use.
      saveBtn.hidden = !(plan === 'new' || plan === 'update' || plan === 'current-update');
      useBtn.hidden = !(plan === 'new' || plan === 'update' || plan === 'exists');
      if (plan === 'exists') useBtn.textContent = 'Use now';
      else useBtn.textContent = 'Save and use now';
      cancelBtn.textContent = plan === 'current' || plan === 'exists' || plan === 'full' ? 'Close' : 'Cancel';
    };

    /** Any edit makes the last check stale. */
    const edited = (): void => {
      seq++;
      if (!checked && status.hidden) return;
      checked = null;
      say('', 'ok');
      checkBtn.disabled = false;
      layout();
    };

    const runCheck = async (): Promise<void> => {
      const mine = ++seq;
      checked = null;
      layout();
      checkBtn.disabled = true;
      say('Checking…', 'busy');
      const electron = getElectronHost();
      const read = await readAddRelayInput(
        manualMode() ? { url: url.value, token: token.value } : { invite: invite.value },
        electron?.relayJoinParse ? (raw) => electron.relayJoinParse!(raw) : null,
      );
      if (mine !== seq || settled) return;
      if (!read.ok) {
        checkBtn.disabled = false;
        say(read.message, 'error');
        return;
      }
      const result = await checkNewRelay(read.link, {
        relayCheck: electron?.pairingRelayCheck ? (p) => electron.pairingRelayCheck!(p) : null,
      });
      if (mine !== seq || settled) return;
      checkBtn.disabled = false;
      if (!result.ok) {
        say(result.message, 'error');
        return;
      }
      checked = { link: read.link, result, plan: addRelayPlan(read.link.relayUrl, read.link.token) };
      say(`${checkSummary(result)}\n${planNote(checked.plan)}`, 'ok');
      layout();
      (saveBtn.hidden ? (useBtn.hidden ? cancelBtn : useBtn) : saveBtn).focus();
    };

    const save = async (useNow: boolean): Promise<void> => {
      const c = checked;
      if (!c) return;
      const done = addSavedRelay(c.link.relayUrl, c.link.token, { info: c.result.info });
      close();
      if (done.kind === 'full') {
        showToast('You have the most saved relays CardMirror keeps. Remove one first.');
        return;
      }
      const name = done.profile.label || relayHostPath(done.profile.url);
      if (!useNow || done.current) {
        showToast(
          done.kind === 'updated'
            ? `Updated the token for ${name}.`
            : done.kind === 'exists'
              ? `${name} is already saved.`
              : `Saved ${name}. Switch to it from Saved relays or the globe in Send and Receive.`,
        );
        return;
      }
      // The same path as the row's Use button, its confirm included.
      const r = await switchRelayNow(done.profile.id);
      if (r === 'cancelled') showToast(`Saved ${name}. You’re still on ${currentRelayLabel()}.`);
    };

    toggle.addEventListener('click', () => {
      const toManual = manual.hidden;
      manual.hidden = !toManual;
      inviteField.hidden = toManual;
      toggle.textContent = toManual ? 'Paste an invite link instead' : 'Enter address and token instead';
      detail.textContent = toManual
        ? 'Enter the relay’s address and token. They’re checked and added to Saved relays; the relay you use now stays in use until you switch.'
        : 'Paste the invite link for the relay. It’s checked and added to Saved relays; the relay you use now stays in use until you switch.';
      edited();
      (toManual ? url : invite).focus();
    });

    // A paste is a whole link (or the last of the two fields): check it
    // right away rather than waiting for Check.
    let pasted = false;
    for (const i of [invite, url, token]) {
      i.addEventListener('paste', () => (pasted = true));
      i.addEventListener('input', () => {
        edited();
        const ready = i === invite ? !!invite.value.trim() : !!url.value.trim() && !!token.value.trim();
        if (pasted && ready) void runCheck();
        pasted = false;
      });
    }

    dialog.append(header, detail, inviteField, manual, toggle, status, buttons);
    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, overlay)) close();
    });
    removeKeys = installModalKeys(dialog, overlayToken, (e) => {
      if (e.key === 'Escape') {
        close();
        return true;
      }
      if (e.key === 'Enter') {
        // A focused button: its own click.
        if (e.target instanceof HTMLButtonElement && dialog.contains(e.target)) return false;
        if (checked && !saveBtn.hidden) void save(false);
        else if (!checked && !checkBtn.disabled) void runCheck();
        return true;
      }
      return false;
    });
    layout();
    document.body.appendChild(overlay);
    armDialogFocus(dialog, 'dialog', 'Add a relay');
    invite.focus();
  });
}

/** Test hook. */
export function __resetAddRelayDialogForTests(): void {
  open = false;
}
