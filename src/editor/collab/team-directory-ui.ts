/**
 * Team directory: what the user sees — the offer ("<team>: 3 teammates to
 * add", or "Join <team>'s team list") as a line at the top of the Send
 * popup with Import / Not now, and a dot on Send while it waits (nothing
 * in the status bar, nothing floating over the page), the display-name prompt behind Import (the same prompt Import
 * team opens with), and the toasts. The logic lives in team-directory.ts.
 *
 * With no custom relay, card sharing off, a relay without the extension,
 * or any error, nothing is shown.
 */

import {
  addSuggestedGroup,
  currentSuggestions,
  groupsChanged,
  onSuggestions,
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
  const token = settings.get('pairingRelayToken');
  const isCurrent = (): boolean => relayBaseUrl() === baseUrl && settings.get('pairingRelayToken') === token;
  return client && baseUrl ? { client, baseUrl, token, isCurrent } : null;
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
  onSuggestions(() => renderOffer());
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
  let groupsTimer: ReturnType<typeof setTimeout> | null = null;
  let prevGroups = settings.get('pairingGroups');
  settings.subscribe((st) => {
    if (st.pairingGroups !== prevGroups) {
      prevGroups = st.pairingGroups;
      if (groupsTimer) clearTimeout(groupsTimer);
      groupsTimer = setTimeout(() => void teamDirectoryContext().then(groupsChanged).catch(() => {}), 2000);
    }
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

/** The offer's slot: a line at the top of the Send popup (the pill makes
 *  it each time it lists contacts). Not in the status bar: it stays quiet
 *  until you open Send, with a dot on Send meanwhile. */
function element(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.getElementById(ELEMENT_ID);
}

function markPill(on: boolean): void {
  if (typeof document === 'undefined') return;
  document.querySelector('.pmd-send-pill')?.classList.toggle('pmd-send-has-offer', on);
}

/** The offer's sentence. */
/** Nobody to import, only this install to add: a new team's first members. */
const addOnly = (o: TeamDirectoryOffer): boolean => o.missing === 0 && !o.listed;

export function offerText(o: TeamDirectoryOffer): string {
  const name = o.directory.name.trim();
  if (addOnly(o)) return name ? `Join ${name}’s team list` : 'Join your team’s list';
  const n = `${o.missing} teammate${o.missing === 1 ? '' : 's'}`;
  return name ? `${name}: ${n} to add` : `Your team: ${n} to add`;
}

export function renderOffer(o: TeamDirectoryOffer | null = currentOffer()): void {
  const suggested = currentSuggestions();
  markPill(!!o || suggested.length > 0);
  const el = element();
  if (!el) return;
  if (!o) {
    el.replaceChildren();
    el.hidden = suggested.length === 0;
    if (suggested.length) renderSuggestionsLine(el, suggested.length);
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

/** "Teammates suggest 2 groups · Review": opens the list in Settings. */
function renderSuggestionsLine(el: HTMLElement, n: number): void {
  const text = document.createElement('span');
  text.className = 'pmd-team-join-requests-text';
  text.textContent = `Teammates suggest ${n} group${n === 1 ? '' : 's'}`;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pmd-team-join-requests-btn pmd-team-join-requests-approve';
  b.textContent = 'Review';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    void import('../settings-ui.js').then((m) => m.openSettings({ category: 'pairing', anchor: 'suggested-groups' }));
  });
  el.append(text, b);
}

/** Settings → Collaboration: the groups teammates suggest, each with Add. */
export function buildSuggestedGroupsSection(onCleanup: (fn: () => void) => void): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'pmd-suggested-groups';
  wrap.id = 'suggested-groups';
  const render = (): void => {
    wrap.replaceChildren();
    const list = currentSuggestions();
    wrap.hidden = list.length === 0;
    if (!list.length) return;
    const title = document.createElement('div');
    title.className = 'pmd-settings-row-title';
    title.textContent = 'Suggested by teammates';
    const desc = document.createElement('div');
    desc.className = 'pmd-settings-row-desc';
    desc.textContent = 'Groups your teammates made from people on this relay’s team list. Add one to use it in the Send pill. Yours are suggested to them the same way.';
    wrap.append(title, desc);
    const names = new Map(settings.get('pairingPartners').map((p) => [p.code, p.name]));
    for (const g of list) {
      const row = document.createElement('div');
      row.className = 'pmd-suggested-group';
      const label = document.createElement('span');
      label.className = 'pmd-suggested-group-label';
      label.textContent = `${g.label} · ${g.memberCodes.length} people`;
      label.title = g.memberCodes.map((c) => names.get(c) || '…' + c.slice(-6)).join(', ');
      const by = document.createElement('span');
      by.className = 'pmd-suggested-group-by';
      by.textContent = g.by.length ? `from ${g.by.slice(0, 2).join(', ')}${g.by.length > 2 ? ` +${g.by.length - 2}` : ''}` : '';
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'Add';
      add.addEventListener('click', () => {
        if (addSuggestedGroup(g)) showToast(`Added the group ${g.label}.`);
        else showToast('None of its people are in your contacts yet.');
      });
      row.append(label, by, add);
      wrap.appendChild(row);
    }
  };
  render();
  onCleanup(onSuggestions(render));
  return wrap;
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
