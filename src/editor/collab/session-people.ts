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
 */

export interface SessionPerson {
  name: string;
  color: string;
  self: boolean;
}

/** People, you first, then everyone else by name. Exported for tests. */
export function orderPeople(people: readonly SessionPerson[]): SessionPerson[] {
  const self = people.filter((p) => p.self);
  const others = people.filter((p) => !p.self).sort((a, b) => a.name.localeCompare(b.name));
  return [...self, ...others];
}

let open: { close: () => void; anchor: HTMLElement } | null = null;

/** Toggle the popover above `anchor`. */
export function toggleSessionPeople(anchor: HTMLElement, getPeople: () => SessionPerson[]): void {
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
  pop.append(title, list, note);

  const render = (): void => {
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
