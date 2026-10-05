/**
 * Sharing is always offered. The Send / Receive pills and the sharing
 * commands used to vanish (or just toast "Card sharing is off") until
 * collaboration was turned on and a relay set — so a fresh install showed
 * no way to share at all ("where are the buttons to share?"). Now they
 * stay, and using one before sharing is set up opens this instead: the
 * one-step team-file import (contacts, groups, relay; turns sharing on)
 * or the Collaboration settings.
 */
import { settings } from '../settings.js';
import { promptForRouteChoice } from '../text-prompt.js';

/** Whether this computer can share right now: collaboration on. (A
 *  missing relay is reported by the send / session paths themselves.) */
export function sharingReady(): boolean {
  return settings.get('pairingEnabled');
}

/** Offer the ways to set sharing up. `why` names what the user tried. */
export async function offerSharingSetup(why?: string): Promise<void> {
  const choice = await promptForRouteChoice<'team' | 'settings'>({
    message: 'Set up card sharing and co-editing',
    detail:
      (why ? `${why} needs sharing set up on this computer. ` : 'Sharing isn’t set up on this computer yet. ') +
      'A team file from your coach does it in one step.',
    choices: [
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
  if (choice === 'team') {
    const m = await import('../settings-ui.js');
    await m.importTeamFile();
  } else if (choice === 'settings') {
    const m = await import('../settings-ui.js');
    m.openSettings({ category: 'pairing' });
  }
}
