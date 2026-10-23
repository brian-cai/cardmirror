/**
 * Relay info: what the user sees — the "About this relay" block in
 * Settings → Collaboration, and the relay's notice as a status-bar notice
 * (non-modal: a toast once, then the ⓘ chip until dismissed).
 *
 * Everything shown comes from the relay's info document
 * (relay-info.ts); with no custom relay, a relay without the extension,
 * or any error, the block stays hidden and no notice is posted. Links
 * open in the system browser through the app's external-link path.
 */

import {
  activeNotice,
  currentRelayInfo,
  installsLine,
  isCustomRelay,
  onRelayInfoChanged,
  refreshRelayInfo,
  updateHint,
  RELAY_INFO_REFRESH_MS,
  type RelayInfo,
  type RelayInfoContext,
} from './relay-info.js';
import { ensureBakedRelay, relayBaseUrl, relayClient } from './collab-relay.js';
import { settings } from '../settings.js';
import { clearNotice, postNotice } from '../status-notices.js';
import { getElectronHost } from '../host/index.js';

// --- refresh ----------------------------------------------------------

async function context(): Promise<RelayInfoContext | null> {
  if (!isCustomRelay()) return null;
  await ensureBakedRelay();
  const client = relayClient();
  const baseUrl = relayBaseUrl();
  return client && baseUrl ? { client, baseUrl } : null;
}

/** Fetch now (`force`: Settings → Collaboration opened) or when the last
 *  fetch is an hour old. Never throws. */
export async function refreshRelayInfoNow(force = false): Promise<void> {
  try {
    await refreshRelayInfo(await context(), { force });
  } catch {
    /* quiet: unsupported or offline shows nothing new */
  }
}

let started = false;

/** Boot: fetch once, then at most hourly; a relay URL/token change
 *  starts over (debounced while the user types). Idempotent. */
export function startRelayInfo(): void {
  if (started) return;
  started = true;
  onRelayInfoChanged((info) => syncRelayNotice(info));
  void refreshRelayInfoNow();
  setInterval(() => void refreshRelayInfoNow(), RELAY_INFO_REFRESH_MS);
  let prevUrl = settings.get('pairingRelayUrl');
  let prevToken = settings.get('pairingRelayToken');
  let timer: ReturnType<typeof setTimeout> | null = null;
  settings.subscribe((st) => {
    if (st.pairingRelayUrl === prevUrl && st.pairingRelayToken === prevToken) return;
    prevUrl = st.pairingRelayUrl;
    prevToken = st.pairingRelayToken;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refreshRelayInfoNow(true), 1000);
  });
}

// --- notice -----------------------------------------------------------

const NOTICE_KEY_PREFIX = 'relay-notice:';
let postedKey: string | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

/** Remember a dismissed notice id so it never shows again (capped). */
export function rememberDismissedNotice(id: string): void {
  const prev = settings.get('relayInfoDismissedNotices');
  if (prev.includes(id)) return;
  settings.set('relayInfoDismissedNotices', [...prev, id].slice(-50));
}

/** Post the relay's notice once per id (per app run, until dismissed),
 *  take it down when the relay drops or replaces it, and when its
 *  `until` passes. */
export function syncRelayNotice(info: RelayInfo | null, now = Date.now()): void {
  const n = activeNotice(info, settings.get('relayInfoDismissedNotices'), now);
  const key = n ? NOTICE_KEY_PREFIX + n.id : null;
  if (postedKey && postedKey !== key) clearNotice(postedKey);
  if (n && key && key !== postedKey) {
    const id = n.id;
    const name = info?.operator?.name;
    postNotice({
      severity: 'info',
      title: name ? `Notice from ${name}` : 'Notice from your relay',
      body: n.text,
      key,
      full: true,
      onDismiss: () => rememberDismissedNotice(id),
    });
  }
  postedKey = key;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
  if (n?.until != null) {
    // setTimeout's ceiling is ~24.8 days; a later `until` re-arms on the
    // next hourly refresh anyway.
    const wait = Math.min(Math.max(0, n.until - now) + 50, 2 ** 31 - 1);
    expiryTimer = setTimeout(() => syncRelayNotice(currentRelayInfo()), wait);
  }
}

/** Test hook: forget the posted notice. */
export function __resetRelayInfoUiForTests(): void {
  postedKey = null;
  if (expiryTimer) clearTimeout(expiryTimer);
  expiryTimer = null;
}

// --- settings block ---------------------------------------------------

/** Open in the system browser (desktop) or a new tab (web) — the same
 *  path the editor's hyperlinks use. */
function openExternally(href: string): void {
  const electron = getElectronHost();
  if (electron) {
    void electron.openExternal(href).catch(() => {});
    return;
  }
  try {
    window.open(href, '_blank', 'noopener,noreferrer');
  } catch {
    /* nothing to do */
  }
}

function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = 'pmd-relay-info-link';
  a.href = href;
  a.textContent = text;
  a.addEventListener('click', (e) => {
    e.preventDefault();
    openExternally(href);
  });
  return a;
}

const host = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The rows of the block, as [label, content]; [] = nothing to show. */
export function relayInfoRows(info: RelayInfo | null): Array<[string, Node]> {
  if (!info) return [];
  const rows: Array<[string, Node]> = [];
  const text = (s: string): Node => document.createTextNode(s);
  const op = info.operator;
  // One line for who runs it: name, then Support and Status links.
  const who = document.createElement('span');
  const sep = (): void => void who.append(text(' \u00b7 '));
  if (op?.name || op?.url) who.append(op.url ? link(op.name || host(op.url), op.url) : text(op.name));
  if (op?.support) {
    if (who.childNodes.length) sep();
    who.append(link('Support', `mailto:${op.support}`));
  }
  if (op?.status) {
    if (who.childNodes.length) sep();
    who.append(link('Status', op.status));
  }
  if (who.childNodes.length) rows.push(['Relay', who]);
  const a = info.access;
  if (a) {
    // Your token's standing; its label is the operator's own bookkeeping.
    const parts: string[] = [];
    if (a.status) parts.push(a.status === 'active' ? 'Active' : 'Suspended');
    if (a.expiresAt !== null) {
      parts.push(`until ${new Date(a.expiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`);
    }
    if (parts.length) rows.push(['Your access', text(parts.join(' \u00b7 '))]);
    const installs = installsLine(a.installs);
    if (installs) rows.push(['Installs', text(installs.replace(/^Installs: /, ''))]);
  }
  const update = updateHint(info);
  if (update) rows.push(['This app', link(`Update available (${update.latest})`, update.url)]);
  return rows;
}

/** "About this relay" for Settings → Collaboration: hidden until the
 *  relay answers with something to show; live while the dialog is open.
 *  Building it (the tab opening) fetches fresh info. */
export function buildRelayInfoSection(onCleanup: (fn: () => void) => void): HTMLElement {
  const wrap = document.createElement('section');
  wrap.className = 'pmd-relay-info-section';
  wrap.dataset['anchor'] = 'about-this-relay';
  wrap.dataset['searchAliases'] = 'about this relay operator support status access installs plan expiry update available';
  const heading = document.createElement('div');
  heading.className = 'pmd-install-info-heading';
  heading.textContent = 'About this relay';
  const list = document.createElement('dl');
  list.className = 'pmd-install-info-list pmd-relay-info-list';
  wrap.append(heading, list);

  const render = (info: RelayInfo | null): void => {
    const rows = isCustomRelay() ? relayInfoRows(info) : [];
    wrap.hidden = rows.length === 0;
    list.replaceChildren();
    for (const [label, content] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.appendChild(content);
      list.append(dt, dd);
    }
  };
  render(currentRelayInfo());
  onCleanup(onRelayInfoChanged(render));
  return wrap;
}
