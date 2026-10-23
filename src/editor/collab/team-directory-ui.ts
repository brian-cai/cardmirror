/**
 * Team directory: what the user sees — the offer "Your team (<name>) is
 * set up on this relay. Import it?" as a status-bar segment with Import /
 * Not now (non-modal: nothing floats over the page and the editor keeps
 * focus), the display-name prompt behind Import (the same prompt Import
 * team opens with), and the toasts. The logic lives in team-directory.ts.
 *
 * With no custom relay, card sharing off, a relay without the extension,
 * or any error, nothing is shown.
 */

import {
  currentOffer,
  dismissOffer,
  importTeamDirectory,
  onTeamDirectoryOffer,
  refreshTeamDirectory,
  updateOwnEntry,
  TEAM_DIRECTORY_REFRESH_MS,
  type TeamDirectoryContext,
  type TeamDirectoryOffer,
} from './team-directory.js';
import { isCustomRelay } from './relay-info.js';
import { ensureBakedRelay, relayBaseUrl, relayClient } from './collab-relay.js';
import { settings } from '../settings.js';
import { showToast } from '../toast.js';
import { getElectronHost } from '../host/index.js';
import type { RegisterRetry } from './team-directory.js';

/** The relay registers only an install whose mailbox it has seen: on its
 *  409, check the mailbox now (desktop) and retry once. */
const registerRetry: RegisterRetry = {
  connectMailbox: async () => {
    await getElectronHost()?.pairingPollNow?.();
  },
};

// --- context + refresh -------------------------------------------------

/** The relay to talk to, or null: no custom relay, or card sharing off. */
export async function teamDirectoryContext(): Promise<TeamDirectoryContext | null> {
  if (!isCustomRelay() || !settings.get('pairingEnabled')) return null;
  await ensureBakedRelay();
  const client = relayClient();
  const baseUrl = relayBaseUrl();
  return client && baseUrl ? { client, baseUrl, token: settings.get('pairingRelayToken') } : null;
}

/** Fetch now (`force`: Settings → Collaboration opened) or when the last
 *  fetch is 5 minutes old. Never throws. */
export async function refreshTeamDirectoryNow(force = false): Promise<void> {
  try {
    await refreshTeamDirectory(await teamDirectoryContext(), { force });
  } catch {
    /* quiet: unsupported or offline shows nothing new */
  }
}

let started = false;

/** Boot: fetch once, then every 5 minutes; a relay URL/token change or
 *  turning card sharing on starts over (debounced); a changed display
 *  name re-registers this install's entry. Idempotent. */
export function startTeamDirectory(): void {
  if (started) return;
  started = true;
  onTeamDirectoryOffer(renderOffer);
  void refreshTeamDirectoryNow();
  setInterval(() => void refreshTeamDirectoryNow(), TEAM_DIRECTORY_REFRESH_MS);
  let prev = {
    url: settings.get('pairingRelayUrl'),
    token: settings.get('pairingRelayToken'),
    enabled: settings.get('pairingEnabled'),
    name: settings.get('pairingDisplayName'),
    code: settings.get('pairingOwnCode'),
  };
  let relayTimer: ReturnType<typeof setTimeout> | null = null;
  let nameTimer: ReturnType<typeof setTimeout> | null = null;
  settings.subscribe((st) => {
    const relayChanged =
      st.pairingRelayUrl !== prev.url || st.pairingRelayToken !== prev.token || st.pairingEnabled !== prev.enabled;
    const meChanged = st.pairingDisplayName !== prev.name || st.pairingOwnCode !== prev.code;
    prev = {
      url: st.pairingRelayUrl,
      token: st.pairingRelayToken,
      enabled: st.pairingEnabled,
      name: st.pairingDisplayName,
      code: st.pairingOwnCode,
    };
    if (relayChanged) {
      if (relayTimer) clearTimeout(relayTimer);
      relayTimer = setTimeout(() => void refreshTeamDirectoryNow(true), 1000);
    }
    if (meChanged) {
      // Typing a name fires per keystroke: send the settled one.
      if (nameTimer) clearTimeout(nameTimer);
      nameTimer = setTimeout(() => {
        void teamDirectoryContext().then((ctx) => (ctx ? updateOwnEntry(ctx, registerRetry) : false)).catch(() => {});
      }, 1500);
    }
  });
}

// --- the offer ----------------------------------------------------------

const ELEMENT_ID = 'team-directory-offer';
let busy = false;

function element(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  let el = document.getElementById(ELEMENT_ID);
  if (el) return el;
  el = document.createElement('div');
  el.id = ELEMENT_ID;
  el.className = 'status-segment pmd-team-join-requests pmd-team-directory-offer';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  // In the status bar before the notices chip; a shell without one (tests,
  // odd layouts) gets the same small fixed strip as join requests.
  const anchor = document.getElementById('notice-chip');
  if (anchor?.parentElement) anchor.insertAdjacentElement('beforebegin', el);
  else {
    el.classList.add('pmd-team-join-requests-floating');
    document.body.appendChild(el);
  }
  return el;
}

/** The offer's sentence. */
/** Nobody to import, only this install to add: a new team's first members. */
const addOnly = (o: TeamDirectoryOffer): boolean => o.missing === 0 && !o.listed;

export function offerText(o: TeamDirectoryOffer): string {
  const name = o.directory.name.trim();
  if (addOnly(o)) {
    return name
      ? `Add yourself to your team’s list (${name}) on this relay?`
      : 'Add yourself to your team’s list on this relay? Teammates who connect get you as a contact.';
  }
  return name ? `Your team (${name}) is set up on this relay. Import it?` : 'Your team is set up on this relay. Import it?';
}

export function renderOffer(o: TeamDirectoryOffer | null = currentOffer()): void {
  const el = o ? element() : typeof document !== 'undefined' ? document.getElementById(ELEMENT_ID) : null;
  if (!el) return;
  if (!o) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  el.replaceChildren();
  const text = document.createElement('span');
  text.className = 'pmd-team-join-requests-text';
  text.textContent = offerText(o);
  el.appendChild(text);
  const act = (label: string, run: () => Promise<void>, primary: boolean): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-team-join-requests-btn' + (primary ? ' pmd-team-join-requests-approve' : '');
    b.textContent = label;
    b.disabled = busy;
    b.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      renderOffer(o);
      void run()
        .catch(() => {})
        .finally(() => {
          busy = false;
          renderOffer();
        });
    });
    return b;
  };
  el.appendChild(act(addOnly(o) ? 'Add me' : 'Import', async () => void (await runImport(o)), true));
  el.appendChild(act('Not now', async () => dismissOffer(o.key, o.directory.revision), false));
}

/** Import: confirm the display name (pre-filled), then register + merge. */
export async function runImport(o: TeamDirectoryOffer): Promise<boolean> {
  const { promptForText } = await import('../text-prompt.js');
  const dir = o.directory;
  const team = dir.name.trim() ? `“${dir.name.trim()}”` : 'your team';
  const groups = dir.groups.length;
  const typed = await promptForText({
    message: 'Your display name',
    detail: addOnly(o)
      ? 'This lists you on the relay’s team list under this name with your send code, so teammates who connect get you as a ' +
        'contact (and you get them as they join). You can change your name later in Settings → Collaboration.'
      : `Importing ${team} adds ${o.missing} ${o.missing === 1 ? 'teammate' : 'teammates'}` +
      (groups ? ` and ${groups === 1 ? 'its group' : `its ${groups} groups`}` : '') +
      ' to your contacts, and lists you on the relay’s team list under this name with your send code. ' +
      'Nothing you already have is removed. You can change your name later in Settings → Collaboration.',
    initial: settings.get('pairingDisplayName').trim(),
    placeholder: 'e.g. Ana Lopez',
    okLabel: addOnly(o) ? 'Add me' : 'Import',
  });
  if (typed == null) return false;
  const ctx = await teamDirectoryContext();
  if (!ctx) return false;
  const out = await importTeamDirectory(ctx, dir, typed, registerRetry);
  if (!out.ok) {
    showToast(
      out.reason === 'no-name'
        ? 'Importing your team needs a display name for teammates to see.'
        : out.reason === 'no-code'
          ? 'Card sharing isn’t set up on this computer yet, so there’s no send code to list you under. Try again once it is.'
          : out.reason === 'not-connected'
            ? 'Card sharing hasn’t connected to this relay yet. Give it a minute, then choose Import again.'
            : 'Couldn’t reach your relay to import your team. Try again in a moment.',
    );
    return false;
  }
  const label = dir.name.trim() ? `“${dir.name.trim()}”` : 'your team';
  showToast(
    addOnly(o)
      ? 'You’re on your team’s list. Teammates who connect will get you as a contact.'
      : out.addedPeople > 0
      ? `Imported ${label}: added ${out.addedPeople} ${out.addedPeople === 1 ? 'teammate' : 'teammates'}.`
      : `Imported ${label}.`,
  );
  return true;
}

/** Test hook. */
export function __resetTeamDirectoryUiForTests(): void {
  busy = false;
  if (typeof document !== 'undefined') document.getElementById(ELEMENT_ID)?.remove();
}
