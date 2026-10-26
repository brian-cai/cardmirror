/**
 * In-editor confirm dialog — a Promise-based replacement for `window.confirm`
 * in editor flows, so a prompt reads as part of the app rather than a jarring
 * OS alert (and doesn't yank focus out of the contenteditable the way the
 * native dialog does). Resolves `true` on confirm, `false` on cancel / Escape /
 * backdrop click. Headless (no `document`) resolves `false`.
 *
 * One confirm style for the whole app: this renders through
 * `confirmDialog` (text-prompt.ts), the same dialog the reminders, the
 * mode switch and the session flows use. It used to draw its own
 * `.pmd-confirm` box, so two yes/no questions in a row could look like
 * they came from two different apps.
 */

import { confirmDialog } from './text-prompt.js';

export interface ConfirmOptions {
  /** Optional bold title line above the message. */
  title?: string;
  /** The body text (supports multiple lines via `\n`). */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as a destructive action. */
  danger?: boolean;
  /** Opened by the app on its own (see ConfirmDialogOptions.unsolicited). */
  unsolicited?: boolean;
  /** One text field under the message (see ConfirmDialogOptions.field). */
  field?: { label: string; placeholder?: string; initial?: string; onInput: (value: string) => void };
}

export function showConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return confirmDialog(opts.message, {
    title: opts.title,
    okLabel: opts.confirmLabel,
    cancelLabel: opts.cancelLabel,
    danger: opts.danger,
    unsolicited: opts.unsolicited,
    field: opts.field,
  });
}
