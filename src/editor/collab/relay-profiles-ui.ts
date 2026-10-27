/**
 * Saved relays: what the user sees — the "Saved relays" list in Settings →
 * Collaboration (Use / Rename / Remove, plus the built-in relay, and
 * "+ Add a relay…", relay-add-ui.ts), the relay
 * chip in the status bar with its quick-switch menu (also the "Switch
 * relay…" command), and the wiring that saves a custom relay once it
 * connects. The logic lives in relay-profiles.ts.
 */

import {
  activeProfile,
  currentRelayLabel,
  isCurrent,
  isSwitchingRelay,
  profilesByUse,
  relabelFromInfo,
  relayEdited,
  relayHostPath,
  rememberConnectedRelay,
  removeProfile,
  renameProfile,
  switchRelay,
  tokenFromAnotherHost,
  BUILTIN_RELAY,
  type SwitchHooks,
  type SwitchResult,
} from './relay-profiles.js';
import { currentRelayInfo, onRelayInfoChanged } from './relay-info.js';
import { anyCollabSessionActive, collabLeaveAllForRelaySwitch } from './collab-hooks.js';
import { settings, type RelayProfile } from '../settings.js';
import { showToast } from '../toast.js';
import { getElectronHost } from '../host/index.js';

// --- switching ----------------------------------------------------------

export const switchHooks: SwitchHooks = {
  sessionLive: () => anyCollabSessionActive(),
  confirmLeave: async (label) => {
    const { confirmDialog } = await import('../text-prompt.js');
    return confirmDialog(
      `You’re in a session on ${label}. Switching relays leaves it. Your copy stays open, and you can rejoin from Sessions after switching back.`,
      { title: 'Leave the session and switch relays?', okLabel: 'Leave and switch' },
    );
  },
  leaveSessions: () => collabLeaveAllForRelaySwitch(),
};

/** Switch, then nudge everything that follows the relay: the mailbox (the
 *  config push already follows the settings; poll now), relay info and the
 *  team directory. Toasts the outcome. */
export async function switchRelayNow(target: string, hooks: SwitchHooks = switchHooks): Promise<SwitchResult> {
  const left = hooks.sessionLive();
  const result = await switchRelay(target, hooks);
  if (result === 'failed') {
    showToast('Couldn’t leave the session safely, so the relay wasn’t switched. Try again in a moment.');
  } else if (result === 'missing') {
    showToast('That saved relay is gone.');
  } else if (result === 'switched') {
    showToast(`Switched to ${currentRelayLabel()}.` + (left ? ' You left the session; switch back to rejoin it.' : ''));
    afterSwitch();
  }
  return result;
}

function afterSwitch(): void {
  const electron = getElectronHost();
  if (settings.get('pairingEnabled')) void electron?.pairingPollNow?.().catch(() => {});
  afterSwitchRefresh.run();
}

/** Relay info and the team directory follow the new relay (they also
 *  notice the settings change; this makes it immediate). A seam for tests. */
export const afterSwitchRefresh = {
  run(): void {
    const custom = !!settings.get('pairingRelayUrl').trim();
    void import('./relay-info-ui.js').then((m) => {
      if (custom) m.startRelayInfo();
      return m.refreshRelayInfoNow(true);
    });
    void import('./team-directory-ui.js').then((m) => {
      if (custom) m.startTeamDirectory();
      return m.refreshTeamDirectoryNow(true);
    });
  },
};

// --- saving on connect ----------------------------------------------------

/** Does the current custom relay accept this URL + token? Desktop asks the
 *  main process (the same check Settings uses); elsewhere the relay info
 *  arriving is the signal (see startRelayProfiles). */
export async function checkCurrentRelay(): Promise<boolean> {
  const relayUrl = settings.get('pairingRelayUrl').trim();
  const relayToken = settings.get('pairingRelayToken');
  const electron = getElectronHost();
  if (!relayUrl || !electron?.pairingRelayCheck) return false;
  if (tokenFromAnotherHost(relayUrl, relayToken)) return false;
  try {
    const r = await electron.pairingRelayCheck({ relayUrl, relayToken });
    // Still the same relay? (The user may have typed on.)
    return r.custom && r.ok && settings.get('pairingRelayUrl').trim() === relayUrl && settings.get('pairingRelayToken') === relayToken;
  } catch {
    return false;
  }
}

async function saveIfConnected(): Promise<void> {
  if (await checkCurrentRelay()) rememberConnectedRelay({ info: currentRelayInfo() });
}

let started = false;

/** Boot: save the current custom relay once it connects (now, and after
 *  every settled URL/token edit), keep the outgoing relay's team key on an
 *  edit, take the relay's own name when it says one, and show the chip.
 *  Idempotent. */
export function startRelayProfiles(): void {
  if (started) return;
  started = true;
  void saveIfConnected();
  onRelayInfoChanged((info) => {
    if (!info || !settings.get('pairingRelayUrl').trim()) return;
    // The relay answered the info call with this token: it's connected.
    if (!activeProfile()) rememberConnectedRelay({ info });
    else relabelFromInfo(info);
  });
  let settled = { url: settings.get('pairingRelayUrl'), token: settings.get('pairingRelayToken') };
  let timer: ReturnType<typeof setTimeout> | null = null;
  settings.subscribe((st, meta) => {
    if (st.pairingRelayUrl === settled.url && st.pairingRelayToken === settled.token) return;
    if (meta?.remote || isSwitchingRelay()) {
      // Another window's edit (it handles the keys), or a switch (it did).
      if (timer) clearTimeout(timer);
      timer = null;
      settled = { url: st.pairingRelayUrl, token: st.pairingRelayToken };
      if (!meta?.remote) void saveIfConnected();
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const prev = settled;
      settled = { url: settings.get('pairingRelayUrl'), token: settings.get('pairingRelayToken') };
      relayEdited(prev);
      void saveIfConnected();
    }, 800);
  });
}

// --- relay switch menu (Send / Receive popups, Settings, the command) -------

const MENU_ID = 'relay-switch-menu';

function closeMenu(): void {
  document.getElementById(MENU_ID)?.remove();
  document.removeEventListener('mousedown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
}

function onOutside(e: MouseEvent): void {
  const menu = document.getElementById(MENU_ID);
  const t = e.target as Node | null;
  if (menu && t && (menu.contains(t) || menuAnchor?.contains(t))) return;
  closeMenu();
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
    menuAnchor?.focus();
  }
}

/** The menu's entries: saved relays (most recent first), then the built-in
 *  relay; `current` marks the one in use. */
export function relayMenuEntries(): Array<{ id: string; label: string; detail: string; current: boolean }> {
  const out = profilesByUse().map((p) => ({
    id: p.id,
    label: p.label || relayHostPath(p.url),
    detail: relayHostPath(p.url),
    current: isCurrent(p.id),
  }));
  out.push({ id: BUILTIN_RELAY, label: 'Built-in relay', detail: '', current: isCurrent(BUILTIN_RELAY) });
  return out;
}

let menuAnchor: HTMLElement | null = null;

/** Open (or close) the quick-switch menu: next to `anchor` (the Send /
 *  Receive popup's globe), else above the status bar (the command). */
export function toggleRelayMenu(anchor: HTMLElement | null = null): void {
  if (document.getElementById(MENU_ID)) {
    closeMenu();
    return;
  }
  menuAnchor = anchor;
  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.className = 'pmd-relay-menu';
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    menu.style.right = 'auto';
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 16 * 16))}px`;
    menu.style.bottom = `${Math.max(8, window.innerHeight - r.top + 6)}px`;
  }
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Switch relay');
  const items: HTMLButtonElement[] = [];
  for (const e of relayMenuEntries()) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-relay-menu-item';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(e.current));
    const check = document.createElement('span');
    check.className = 'pmd-relay-menu-check';
    check.textContent = e.current ? '✓' : '';
    const text = document.createElement('span');
    text.className = 'pmd-relay-menu-label';
    text.textContent = e.label;
    b.append(check, text);
    if (e.detail && e.detail !== e.label) {
      const d = document.createElement('span');
      d.className = 'pmd-relay-menu-detail';
      d.textContent = e.detail;
      b.appendChild(d);
    }
    b.addEventListener('click', () => {
      closeMenu();
      if (!e.current) void switchRelayNow(e.id);
    });
    items.push(b);
    menu.appendChild(b);
  }
  const sep = document.createElement('div');
  sep.className = 'pmd-relay-menu-sep';
  menu.appendChild(sep);
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'pmd-relay-menu-item pmd-relay-menu-manage';
  manage.setAttribute('role', 'menuitem');
  manage.textContent = 'Manage saved relays…';
  manage.addEventListener('click', () => {
    closeMenu();
    void import('../settings-ui.js').then((m) => m.openSettings({ category: 'pairing', anchor: 'saved-relays' }));
  });
  items.push(manage);
  menu.appendChild(manage);
  menu.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
    ev.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const n = items.length;
    items[(i + (ev.key === 'ArrowDown' ? 1 : n - 1) + n) % n]?.focus();
  });
  document.body.appendChild(menu);
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
}

// --- Settings → Collaboration: Saved relays ---------------------------------

const when = (ms: number): string =>
  ms > 0 ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'never';

/** "Saved relays": every custom relay this install connected to, with the
 *  built-in relay last. Live while the dialog is open. */
export function buildSavedRelaysSection(onCleanup: (fn: () => void) => void): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'pmd-saved-relays';
  const heading = document.createElement('div');
  heading.className = 'pmd-settings-row-title';
  heading.textContent = 'Saved relays';
  const desc = document.createElement('div');
  desc.className = 'pmd-settings-row-desc';
  desc.textContent =
    'Every custom relay you connect to is saved here with its own team key, so you can switch back in one click ' +
    '(also from the globe in the Send and Receive popups). The Send pill shows the contacts on the relay you’re using. ' +
    '+ Add a relay… saves another relay from its invite link without switching to it.';
  const list = document.createElement('div');
  list.className = 'pmd-saved-relays-list';
  // Below the list (Built-in relay last): add one without typing over the
  // Custom relay fields, which stay the relay in use (relay-add-ui.ts).
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pmd-settings-backup-btn pmd-saved-relays-add';
  add.textContent = '+ Add a relay…';
  add.addEventListener('click', () => void import('./relay-add-ui.js').then((m) => m.openAddRelayDialog()));
  wrap.append(heading, desc, list, add);

  const button = (text: string, run: () => void, disabled = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pmd-settings-backup-btn';
    b.textContent = text;
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  };

  const row = (label: string, detail: string, actions: HTMLElement[]): HTMLElement => {
    const r = document.createElement('div');
    r.className = 'pmd-saved-relay';
    const info = document.createElement('div');
    info.className = 'pmd-saved-relay-info';
    const name = document.createElement('div');
    name.className = 'pmd-saved-relay-label';
    name.textContent = label;
    const d = document.createElement('div');
    d.className = 'pmd-settings-row-desc pmd-saved-relay-detail';
    d.textContent = detail;
    info.append(name, d);
    const act = document.createElement('div');
    act.className = 'pmd-settings-backup-actions';
    act.append(...actions);
    r.append(info, act);
    return r;
  };

  const render = (): void => {
    list.replaceChildren();
    for (const p of profilesByUse()) {
      const current = isCurrent(p.id);
      list.appendChild(
        row(
          p.label || relayHostPath(p.url),
          `${relayHostPath(p.url)} · ${current ? 'in use' : p.lastUsed > 0 ? `last used ${when(p.lastUsed)}` : 'saved, not used yet'}`,
          [
            button(current ? 'In use' : 'Use', () => void switchRelayNow(p.id), current),
            button('Rename', () => void rename(p)),
            button('Remove', () => void remove(p), current),
          ],
        ),
      );
    }
    const builtin = isCurrent(BUILTIN_RELAY);
    list.appendChild(
      row('Built-in relay', builtin ? 'in use' : 'the default relay (no custom URL)', [
        button(builtin ? 'In use' : 'Use', () => void switchRelayNow(BUILTIN_RELAY), builtin),
      ]),
    );
  };

  render();
  let prev = '';
  const sig = (): string =>
    JSON.stringify([settings.get('relayProfiles'), settings.get('pairingRelayUrl'), settings.get('pairingRelayToken')]);
  prev = sig();
  onCleanup(
    settings.subscribe(() => {
      const next = sig();
      if (next === prev) return;
      prev = next;
      render();
    }),
  );
  return wrap;
}

async function rename(p: RelayProfile): Promise<void> {
  const { promptForText } = await import('../text-prompt.js');
  const name = await promptForText({
    message: 'Name this relay',
    detail: `${relayHostPath(p.url)}. Leave it empty to use the relay’s own name.`,
    initial: p.labelCustom ? p.label : '',
    placeholder: p.label,
    okLabel: 'Save',
  });
  if (name == null) return;
  renameProfile(p.id, name, isCurrent(p.id) ? currentRelayInfo() : null);
}

async function remove(p: RelayProfile): Promise<void> {
  const { confirmDialog } = await import('../text-prompt.js');
  const ok = await confirmDialog(
    `Forget ${p.label || relayHostPath(p.url)}? Its address, token and team key are removed from this computer. Your contacts and groups stay.`,
    { title: 'Remove saved relay?', okLabel: 'Remove' },
  );
  if (ok && !removeProfile(p.id)) showToast('Switch to another relay before removing this one.');
}

/** Test hook. */
export function __resetRelayProfilesUiForTests(): void {
  started = false;
  if (typeof document !== 'undefined') {
    closeMenu();
  }
}
