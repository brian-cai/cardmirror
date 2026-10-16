/**
 * Add someone you've met through CardMirror — the sender of an invite, or a
 * person in a shared session — to your contacts by their pairing code,
 * asking for the name (pre-filled with the display name they go by).
 */
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { promptForText } from '../text-prompt.js';
import { looksLikePairingCode, normalizePairingCode } from './pairing-ids.js';

/** True when `rawCode` is a valid code that isn't yours and isn't already a contact. */
export function canAddContact(rawCode: string | undefined): boolean {
  const code = rawCode ? normalizePairingCode(rawCode) : '';
  if (!looksLikePairingCode(code)) return false;
  if (normalizePairingCode(settings.get('pairingOwnCode')) === code) return false;
  return !settings.get('pairingPartners').some((p) => normalizePairingCode(p.code) === code);
}

/** Save `rawCode` as a contact. Resolves true when added (or when another
 *  window added them while the prompt was open). */
export async function addContact(rawCode: string | undefined, suggestedName: string | undefined): Promise<boolean> {
  if (!canAddContact(rawCode)) return false;
  const code = normalizePairingCode(rawCode!);
  const named = await promptForText({
    message: 'Add to contacts',
    detail: 'Shown in the Send pill and on cards and invites you get from them.',
    initial: (suggestedName || '').trim(),
    placeholder: 'Name',
    okLabel: 'Add',
  });
  if (named == null) return false;
  // Re-check: another window may have added them while the prompt was open.
  if (!canAddContact(code)) return true;
  const name = named.trim();
  settings.set('pairingPartners', [...settings.get('pairingPartners'), { code, name }]);
  showToast(`Added ${name || `…${code.slice(-6)}`} to your contacts`);
  return true;
}
