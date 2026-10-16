/**
 * "Who's in this session" — a small popover listing everyone in a
 * collaboration session (colored dot + name, you first), opened by clicking
 * the session status ("Session: synced" in the status bar, or a pane's
 * "Synced" footer in three-pane mode). The presence dots alone only named
 * people on hover.
 *
 * The roster comes from the session's cursor-presence store (people whose
 * cursors were seen recently); the list refreshes while open, so someone
 * joining or leaving shows up within a few seconds.
 *
 * Someone who publishes their pairing code and isn't a contact yet gets an
 * "Add contact" button (name pre-filled with their display name).
 */
import { addContact, canAddContact } from '../pairing/add-contact.js';

export interface SessionPerson {
  name: string;
  color: string;
  self: boolean;
  /** Their pairing code, when their build publishes it. */
  code?: string;
}

/** People, you first, then everyone else by name. Exported for tests. */
export function orderPeople(people: readonly SessionPerson[]): SessionPerson[] {
  const self = people.filter((p) => p.self);
  const others = people.filter((p) => !p.self).sort((a, b) => a.name.localeCompare(b.name));
  return [...self, ...others];
}

/** The session's connection, for the status line shown while it's offline
 *  or still sending. */
export interface SessionConnection {
  connected: boolean;
  queued: number;
  offlineSince: number | null;
  reconnect: () => void;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The status line's text, or null when synced. Exported for tests. */
export function connectionText(c: SessionConnection, now: number = Date.now()): string | null {
  if (c.connected) return c.queued > 0 ? `Sending ${plural(c.queued, 'edit')}\u2026` : null;
  const mins = c.offlineSince === null ? 0 : Math.floor((now - c.offlineSince) / 60_000);
  const head = mins >= 1 ? `Offline for ${plural(mins, 'minute')}.` : 'Offline \u2014 reconnecting\u2026';
  const tail =
    c.queued > 0
      ? `${plural(c.queued, 'edit')} saved on this computer will send when it reconnects.`
      : 'Your edits are saved on this computer and send when it reconnects.';
  return `${head} ${tail}`;
}

let open: { close: () => void; anchor: HTMLElement } | null = null;

/** Toggle the popover above `anchor`. */
export function toggleSessionPeople(
  anchor: HTMLElement,
  getPeople: () => SessionPerson[],
  getConnection?: () => SessionConnection | null,
): void {
  if (open) {
    const wasSame = open.anchor === anchor;
    open.close();
    if (wasSame) return;
  }
  const pop = document.createElement('div');
  pop.className = 'pmd-session-people';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'People in this session');
  const title = document.createElement('div');
  title.className = 'pmd-session-people-title';
  const list = document.createElement('ul');
  list.className = 'pmd-session-people-list';
  const note = document.createElement('div');
  note.className = 'pmd-session-people-note';
  note.textContent = 'Shows people who have the document open right now.';
  const status = document.createElement('div');
  status.className = 'pmd-session-people-status';
  status.hidden = true;
  const statusText = document.createElement('span');
  const reconnectBtn = document.createElement('button');
  reconnectBtn.type = 'button';
  reconnectBtn.className = 'pmd-session-people-btn pmd-session-people-reconnect';
  reconnectBtn.textContent = 'Reconnect now';
  reconnectBtn.addEventListener('click', () => {
    getConnection?.()?.reconnect();
    reconnectBtn.disabled = true;
    reconnectBtn.textContent = 'Reconnecting\u2026';
    // Re-arm after a few seconds if it's still offline.
    setTimeout(() => {
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = 'Reconnect now';
    }, 4000);
  });
  status.append(statusText, reconnectBtn);
  pop.append(title, status, list, note);

  const render = (): void => {
    const conn = getConnection?.() ?? null;
    const line = conn ? connectionText(conn) : null;
    status.hidden = line === null;
    statusText.textContent = line ?? '';
    reconnectBtn.hidden = !conn || conn.connected;
    const people = orderPeople(getPeople());
    const n = people.length;
    title.textContent = n === 1 ? 'Just you in this session' : `${n} people in this session`;
    list.replaceChildren(
      ...people.map((p) => {
        const li = document.createElement('li');
        const dot = document.createElement('span');
        dot.className = 'pmd-collab-presence-dot' + (p.self ? ' pmd-collab-presence-dot-self' : '');
        dot.style.background = p.color;
        const name = document.createElement('span');
        name.textContent = p.self ? `${p.name} (you)` : p.name;
        li.append(dot, name);
        if (!p.self && canAddContact(p.code)) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'pmd-session-people-btn pmd-session-people-add';
          add.textContent = 'Add contact';
          add.title = `Add ${p.name} to your contacts`;
          add.addEventListener('click', () => {
            void addContact(p.code, p.name).then(() => {
              if (open?.anchor === anchor) render();
            });
          });
          li.append(add);
        }
        return li;
      }),
    );
  };
  render();
  document.body.appendChild(pop);

  // Above the anchor, right-aligned to it, kept on screen.
  const place = (): void => {
    const a = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
    pop.style.left = `${left}px`;
    pop.style.bottom = `${window.innerHeight - a.top + 6}px`;
  };
  place();

  const timer = setInterval(() => {
    if (!anchor.isConnected || anchor.hidden) {
      close();
      return;
    }
    render();
    place();
  }, 2000);
  const onDown = (e: PointerEvent): void => {
    if (e.target instanceof Node && (pop.contains(e.target) || anchor.contains(e.target))) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  function close(): void {
    clearInterval(timer);
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    pop.remove();
    open = null;
  }
  open = { close, anchor };
}
