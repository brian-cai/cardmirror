/**
 * Sharing is always offered. The Send / Receive pills and the sharing
 * commands used to vanish (or just toast "Card sharing is off") until
 * collaboration was turned on and a relay set — so a fresh install showed
 * no way to share at all ("where are the buttons to share?"). Now they
 * stay, and using one before sharing is set up opens this instead: paste
 * the coach's invite link, the one-step team-file import (contacts,
 * groups, relay; turns sharing on), or the Collaboration settings.
 */
import { settings } from '../settings.js';
import { promptForRouteChoice, promptForText } from '../text-prompt.js';
import { relayUsable } from '../collab/collab-relay.js';

/** Whether this computer can share right now: collaboration on and a
 *  relay it can use. Collaboration is on by default, so a fresh install
 *  with no relay, account or team file gets the setup offer instead of a
 *  send that fails. */
export function sharingReady(): boolean {
  return settings.get('pairingEnabled') && relayUsable();
}

/** Offer the ways to set sharing up. `why` names what the user tried. */
export async function offerSharingSetup(why?: string): Promise<void> {
  const choice = await promptForRouteChoice<'link' | 'team' | 'settings'>({
    message: 'Set up card sharing and co-editing',
    detail:
      (why ? `${why} needs sharing set up on this computer. ` : 'Sharing isn’t set up on this computer yet. ') +
      'An invite link or a team file from your coach does it in one step.',
    choices: [
      {
        value: 'link',
        label: 'Paste an invite link',
        description: 'The link your coach sent (extinction.gg/relay/join…). Connects you to your team’s relay.',
      },
      {
        value: 'team',
        label: 'Import a team file',
        description: 'A .cmteam file: your contacts, groups and the team relay. Turns sharing on.',
      },
      {
        value: 'settings',
        label: 'Set up in Settings',
        description: 'Turn on collaboration and connect a relay or account yourself.',
      },
    ],
  });
  if (choice === 'link') {
    const text = await promptForText({
      message: 'Paste your team’s invite link',
      placeholder: 'https://extinction.gg/relay/join#…',
      okLabel: 'Connect',
    });
    if (!text) return;
    const { joinRelayFromText } = await import('./relay-join.js');
    if (!(await joinRelayFromText(text))) {
      const { showToast } = await import('../toast.js');
      showToast('That isn’t an invite link. Ask your coach to resend it.');
    }
  } else if (choice === 'team') {
    const m = await import('../settings-ui.js');
    await m.importTeamFile();
  } else if (choice === 'settings') {
    const m = await import('../settings-ui.js');
    m.openSettings({ category: 'pairing' });
  }
}
