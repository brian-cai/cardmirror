/**
 * Receive pill — the inbox of cards other machines have sent you.
 *
 * Behaves like the dropzone shelf (drag a row out into the doc, or click
 * to insert at the cursor / Alt-click to append) but each row also shows
 * WHO sent it and WHEN, and the pill flashes green when a card lands. The
 * count badge shows total received plus how many are still unread; opening
 * the pill marks everything read (and stops a "keep flashing" loop).
 *
 * Backed by `inbox-store` (main-process-owned, cross-window). Receiving is
 * driven by the main poller; this is purely display + drag-out.
 */

import { Slice } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { dragController, type DragItem } from '../drag-controller.js';
import { schema } from '../../schema/index.js';
import { setIcon } from '../icons';
import { typeBadge, dropzoneDragLevel, previewRowButton } from '../dropzone-ui.js';
import { openCardPreview } from '../card-preview-modal.js';
import { isAnyOverlayOpen } from '../overlay-stack.js';
import { settings } from '../settings.js';
import {
  inboxItemCardCount, inboxStore, type InboxItem } from './inbox-store.js';
import { insertReceivedItem, RECEIVE_NEEDS_DOC_MESSAGE } from './inbox-insert.js';
import { showToast } from '../toast.js';
import { addContact, canAddContact } from './add-contact.js';
import { parseRoomInvite } from './room-invite.js';
import { collabEnabled } from '../collab/collab-gate.js';
import { offerSharingSetup, sharingReady } from './sharing-setup.js';
import { collabSettingsAvailable, collabSettingsButton, relaySwitchButton } from './collab-settings-button.js';
import { collabInviteJoiner, collabSessionJoinPrompt } from '../collab/collab-hooks.js';
import { deletePrefetch } from '../collab/collab-store.js';
import { checkedSliceFromJSON } from '../../schema/slice-check.js';

interface ReceivePillMountOptions {
  parent: HTMLElement;
  getFocusedView: () => EditorView | null;
}

const PULSE_MS = 700;
const REPEAT_MS = 10000;

/** The session-invite row's type chip — three letters like every other chip. */
export const SESSION_BADGE_LABEL = 'SES';

export class ReceivePillController {
  private root!: HTMLDivElement;
  private bar!: HTMLDivElement;
  private listEl!: HTMLUListElement;
  private joinSessionEl: HTMLButtonElement | null = null;
  /** Footer Clear — empties the inbox; shown only while it has items. */
  private clearEl: HTMLButtonElement | null = null;
  private actionsLi: HTMLLIElement | null = null;
  private badge!: HTMLSpanElement;
  private getFocusedView: () => EditorView | null = () => null;
  private items: InboxItem[] = [];
  private open = false;
  /** Whether the folded older session invites are shown (this window). */
  private sessionsExpanded = false;
  private seenIds = new Set<string>();
  private flashTimer: number | null = null;
  private pulseTimer: number | null = null;
  private unsubscribeStore: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeController: (() => void) | null = null;
  private dragOutSource: {
    startX: number;
    startY: number;
    item: InboxItem;
    started: boolean;
    altKey: boolean;
  } | null = null;

  /** The pill's root element — re-parented by the shell between the
   *  editor pill tray and the home screen's dock (listeners ride along
   *  with the node, so the pill works identically in either host). */
  rootEl(): HTMLElement | null {
    return this.root ?? null;
  }

  mount(opts: ReceivePillMountOptions): void {
    this.getFocusedView = opts.getFocusedView;

    this.root = document.createElement('div');
    this.root.className = 'pmd-pill pmd-receive-pill';
    this.root.dataset['open'] = 'false';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Received cards');

    this.listEl = document.createElement('ul');
    this.listEl.className = 'pmd-receive-list pmd-pill-popup';
    this.root.appendChild(this.listEl);

    // Footer action inside the popup list: join a session by pasted
    // code. Unconditional (no session state to depend on — joining is
    // always possible); hidden only where collab itself is (web
    // edition / joiner not wired). Built once; render() re-appends it
    // after clearing the list, so listeners survive.
    this.actionsLi = document.createElement('li');
    this.actionsLi.className = 'pmd-receive-actions';
    this.joinSessionEl = document.createElement('button');
    this.joinSessionEl.type = 'button';
    this.joinSessionEl.className = 'pmd-receive-action';
    this.joinSessionEl.innerHTML =
      '<span class="pmd-send-action-icon" aria-hidden="true">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>' +
      '</span><span>Join session</span>';
    this.joinSessionEl.title = 'Join a collaboration session with a pasted session code or invite link';
    this.joinSessionEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setOpen(false);
      collabSessionJoinPrompt()?.();
    });
    this.actionsLi.appendChild(this.joinSessionEl);
    // Clear, like the dropzone's: everything received goes, no prompt
    // (a resend is always possible). Shown only while there are items.
    this.clearEl = document.createElement('button');
    this.clearEl.type = 'button';
    this.clearEl.className = 'pmd-receive-action pmd-receive-clear';
    this.clearEl.title = 'Remove everything received';
    const clearIcon = document.createElement('span');
    clearIcon.className = 'pmd-send-action-icon';
    setIcon(clearIcon, 'trash');
    this.clearEl.appendChild(clearIcon);
    const clearLabel = document.createElement('span');
    clearLabel.textContent = 'Clear';
    this.clearEl.appendChild(clearLabel);
    this.clearEl.addEventListener('click', (e) => {
      e.stopPropagation();
      void inboxStore.clear();
    });
    this.actionsLi.appendChild(this.clearEl);
    if (collabSettingsAvailable()) {
      const relay = relaySwitchButton('pmd-receive-action');
      if (relay) this.actionsLi.appendChild(relay);
      this.actionsLi.appendChild(collabSettingsButton('pmd-receive-action', () => this.setOpen(false)));
    }

    this.bar = document.createElement('div');
    this.bar.className = 'pmd-pill-bar pmd-receive-bar';
    this.bar.setAttribute('role', 'button');
    this.bar.setAttribute('tabindex', '0');
    this.bar.title = 'Cards other people sent you';
    const icon = document.createElement('span');
    icon.className = 'pmd-pill-icon';
    icon.setAttribute('aria-hidden', 'true');
    // In-tray (the icon set's `download`), paired with Send's out-tray.
    setIcon(icon, 'download');
    this.bar.appendChild(icon);
    const labelEl = document.createElement('span');
    labelEl.className = 'pmd-pill-label';
    labelEl.textContent = 'Receive';
    this.bar.appendChild(labelEl);

    // One combined badge: "total · N new" (blue) when there are unread
    // cards, fading to just "total" (gray) once everything's been seen.
    this.badge = document.createElement('span');
    this.badge.className = 'pmd-pill-badge pmd-receive-badge';
    this.badge.hidden = true;
    this.bar.appendChild(this.badge);

    const toggle = (e: Event): void => {
      e.stopPropagation();
      if (!sharingReady()) {
        void offerSharingSetup('Receiving cards');
        return;
      }
      this.setOpen(!this.open);
    };
    this.bar.addEventListener('click', toggle);
    this.bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle(e);
      }
    });

    this.root.appendChild(this.bar);
    opts.parent.appendChild(this.root);

    void inboxStore.init().then(() => {
      this.items = inboxStore.list();
      this.seenIds = new Set(this.items.map((it) => it.id));
      this.render();
      // Resume "keep flashing" for cards still unread from a previous
      // session — they haven't been seen yet, so the reminder continues.
      if (
        settings.get('pairingReceiveFlash') === 'repeat' &&
        inboxDisplayUnread(this.items) > 0 &&
        !this.open
      ) {
        this.handleArrival();
      }
    });
    this.unsubscribeStore = inboxStore.subscribe((items) => {
      this.onStoreChange(items);
    });
    this.unsubscribeSettings = settings.subscribe(() => {
      this.applyVisibility();
      if (settings.get('pairingReceiveFlash') === 'off') this.stopRepeat();
    });
    this.unsubscribeController = dragController.subscribe((event) => {
      if (event === 'end') this.endDragOut();
    });

    this.applyVisibility();
    document.addEventListener('pointerdown', this.onDocumentPointerDown);
  }

  unmount(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown);
    this.unsubscribeStore?.();
    this.unsubscribeSettings?.();
    this.unsubscribeController?.();
    this.stopRepeat();
    this.root.remove();
  }

  /** Always shown where sharing can exist (see sharing-setup.ts); before
   *  it's set up, a click offers setup. */
  private applyVisibility(): void {
    this.root.hidden = !collabEnabled();
  }

  private onStoreChange(items: InboxItem[]): void {
    // A session invite that came through a group is listed but quiet: only
    // cards and invites sent to you by name flash the pill.
    const arrivals = items.filter((it) => !this.seenIds.has(it.id) && !it.read && !isGroupInvite(it));
    for (const it of items) this.seenIds.add(it.id);
    this.items = items;
    this.render();
    if (arrivals.length > 0 && !this.open) this.handleArrival();
  }

  // ---- Flash --------------------------------------------------------

  private handleArrival(): void {
    const mode = settings.get('pairingReceiveFlash');
    if (mode === 'off') return;
    this.pulse();
    if (mode === 'repeat') this.startRepeat();
  }

  /** One green pulse — the command-bar / repair-paragraph technique:
   *  drop the class, force reflow to restart, re-add, clear after the
   *  animation. A timeout (not `animationend`) so reduced-motion, which
   *  disables the keyframe, still clears the class. */
  private pulse(): void {
    this.root.classList.remove('pmd-pill-flash');
    void this.root.offsetWidth; // reflow
    this.root.classList.add('pmd-pill-flash');
    if (this.pulseTimer !== null) window.clearTimeout(this.pulseTimer);
    this.pulseTimer = window.setTimeout(() => {
      this.root.classList.remove('pmd-pill-flash');
      this.pulseTimer = null;
    }, PULSE_MS);
  }

  private startRepeat(): void {
    this.stopRepeat();
    this.flashTimer = window.setInterval(() => {
      if (!settings.get('pairingEnabled') || inboxDisplayUnread(this.items) === 0 || this.open) {
        this.stopRepeat();
        return;
      }
      this.pulse();
    }, REPEAT_MS);
  }

  private stopRepeat(): void {
    if (this.flashTimer !== null) {
      window.clearInterval(this.flashTimer);
      this.flashTimer = null;
    }
  }

  // ---- Rendering ----------------------------------------------------

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.dataset['open'] = open ? 'true' : 'false';
    if (open) {
      this.stopRepeat();
      this.root.classList.remove('pmd-pill-flash');
      void inboxStore.markAllRead();
    }
    this.render();
  }

  private render(): void {
    const total = inboxDisplayCount(this.items);
    const unread = inboxDisplayUnread(this.items);
    this.badge.hidden = total === 0;
    this.badge.textContent = unread > 0 ? `${total} · ${unread} new` : String(total);
    this.badge.classList.toggle('pmd-receive-badge-unread', unread > 0);
    this.root.classList.toggle('pmd-pill-empty', total === 0);

    this.listEl.innerHTML = '';
    if (total === 0) {
      const empty = document.createElement('li');
      empty.className = 'pmd-receive-empty';
      empty.textContent = "You haven't received anything yet.";
      this.listEl.appendChild(empty);
    } else {
      // Session invites gather into one row per session (an edit and a
      // watch invite to the same room share it). With several sessions in
      // a round, only the newest stays open and the rest fold behind one
      // "N more session invites" line, so cards stay in reach. The block
      // sits where its newest invite falls in the newest-first list.
      const rooms = groupSessionInvites(this.items);
      const cards = [...this.items].reverse().filter((it) => !parseRoomInvite(it));
      const sessionAt = rooms[0]?.newest.receivedAt ?? -Infinity;
      let placed = rooms.length === 0;
      const placeSessions = (): void => {
        placed = true;
        const [newest, ...older] = rooms;
        this.listEl.appendChild(this.renderInviteRow(newest!));
        if (older.length === 1) {
          this.listEl.appendChild(this.renderInviteRow(older[0]!));
        } else if (older.length > 1) {
          this.listEl.appendChild(this.renderSessionFold(older));
          if (this.sessionsExpanded) {
            for (const room of older) this.listEl.appendChild(this.renderInviteRow(room));
          } else {
            // Folded rows still prefetch their seed so a later Join works offline.
            for (const room of older) prefetchRoom(room);
          }
        }
      };
      for (const item of cards) {
        if (!placed && item.receivedAt < sessionAt) placeSessions();
        this.listEl.appendChild(this.renderRow(item));
      }
      if (!placed) placeSessions();
    }
    if (this.actionsLi) {
      const canJoin = collabEnabled() && collabSessionJoinPrompt() !== null;
      if (this.joinSessionEl) this.joinSessionEl.hidden = !canJoin;
      if (this.clearEl) this.clearEl.hidden = total === 0;
      this.actionsLi.hidden = !canJoin && total === 0 && !collabSettingsAvailable();
      this.listEl.appendChild(this.actionsLi);
    }
  }

  private renderRow(item: InboxItem): HTMLLIElement {
    const row = document.createElement('li');
    row.className = 'pmd-receive-row';
    if (!item.read) row.classList.add('pmd-receive-row-unread');

    const badge = document.createElement('span');
    const { kind, label: typeLabel } = typeBadge(item.type);
    badge.className = `pmd-dropzone-row-type pmd-dropzone-row-type-${kind}`;
    badge.textContent = typeLabel;
    row.appendChild(badge);

    // Bundled multi-selection send → ×N count beside the type chip.
    // Everything about the row stays atomic: click, drag-out, and ✕
    // all act on the whole bundle (partial grabs are deliberately not
    // a thing — the sender chose what travels together).
    const cardCount = inboxItemCardCount(item);
    if (cardCount > 1) {
      const count = document.createElement('span');
      count.className = 'pmd-receive-row-count';
      count.textContent = `×${cardCount}`;
      count.title = `${cardCount} cards — inserted together`;
      row.appendChild(count);
    }

    const main = document.createElement('span');
    main.className = 'pmd-receive-row-main';
    const label = document.createElement('span');
    label.className = 'pmd-receive-row-label';
    label.textContent = item.label;
    label.title = item.label;
    main.appendChild(label);
    const meta = document.createElement('span');
    meta.className = 'pmd-receive-row-meta';
    meta.textContent = `${resolveSender(item)} · ${relTime(item.receivedAt)}`;
    meta.title = meta.textContent;
    main.appendChild(meta);
    row.appendChild(main);

    // Look before you insert: a full-size read-only preview with Copy.
    const subtitle = meta.textContent;
    row.appendChild(
      previewRowButton(() => openCardPreview({ title: item.label, subtitle, sliceJson: item.sliceJson })),
    );

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-dropzone-row-delete';
    del.title = 'Remove';
    del.setAttribute('aria-label', 'Remove');
    setIcon(del, 'close');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void inboxStore.remove(item.id);
    });
    row.appendChild(del);

    row.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('.pmd-dropzone-row-delete, .pmd-row-preview')) return;
      this.dragOutSource = {
        startX: e.clientX,
        startY: e.clientY,
        item,
        started: false,
        altKey: e.altKey,
      };
      window.addEventListener('pointermove', this.onDragOutPointerMove);
      window.addEventListener('pointerup', this.onDragOutPointerUp);
      e.preventDefault();
    });

    return row;
  }

  /** "N more session invites" — toggles the older session rows. */
  private renderSessionFold(older: SessionRoom[]): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'pmd-receive-row pmd-receive-session-fold';
    if (older.some(roomUnread)) li.classList.add('pmd-receive-row-unread');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pmd-receive-session-fold-btn';
    btn.setAttribute('aria-expanded', String(this.sessionsExpanded));
    const n = older.length;
    btn.textContent = this.sessionsExpanded
      ? `Hide ${n} older session invite${n === 1 ? '' : 's'}`
      : `${n} more session invite${n === 1 ? '' : 's'}`;
    btn.title = older
      .slice(0, 12)
      .map((r) => `${r.title || 'Untitled session'} \u2014 ${resolveSender(r.newest)}`)
      .join('\n');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.sessionsExpanded = !this.sessionsExpanded;
      this.render();
    });
    li.appendChild(btn);
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'pmd-receive-session-fold-clear';
    clear.textContent = 'Clear these';
    clear.title = 'Remove these older session invites (the newest stays)';
    clear.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const room of older) removeRoom(room);
    });
    li.appendChild(clear);
    return li;
  }

  /** A session's invites (an edit invite, a watch invite, or both): not
   *  draggable/insertable — its actions are Join and Watch. Old clients
   *  never see these rows (the envelope's version floor drops the message
   *  in main with the update toast); a client with the collab gate closed
   *  shows the row without the buttons. */
  private renderInviteRow(room: SessionRoom): HTMLLIElement {
    prefetchRoom(room);
    const item = room.newest;
    const row = document.createElement('li');
    row.className = 'pmd-receive-row pmd-receive-row-invite';
    if (roomUnread(room)) row.classList.add('pmd-receive-row-unread');

    const badge = document.createElement('span');
    badge.className = 'pmd-dropzone-row-type pmd-dropzone-row-type-generic';
    badge.textContent = SESSION_BADGE_LABEL;
    row.appendChild(badge);

    const main = document.createElement('span');
    main.className = 'pmd-receive-row-main';
    const label = document.createElement('span');
    label.className = 'pmd-receive-row-label';
    // A `cmview1.` code is a SPECTATE invite: joining watches the document
    // live without editing (the session is view-only end to end).
    const watchOnly = !room.edit;
    label.textContent = room.title
      ? `\u201c${room.title}\u201d`
      : watchOnly
        ? 'A session to watch'
        : 'A collaboration session';
    label.title = watchOnly
      ? `Invited you to watch ${room.title ? `\u201c${room.title}\u201d` : 'a collaboration session'}`
      : `Invited you to collaborate on ${room.title ? `\u201c${room.title}\u201d` : 'a collaboration session'}`;
    main.appendChild(label);
    const meta = document.createElement('span');
    meta.className = 'pmd-receive-row-meta';
    const senders = [...new Set(room.items.map((it) => resolveSender(it)))];
    meta.textContent = `${senders.join(', ')}${watchOnly ? ' \u00b7 view only' : ''} \u00b7 ${relTime(item.receivedAt)}`;
    meta.title = meta.textContent;
    main.appendChild(meta);
    row.appendChild(main);

    // The invite carries the inviter's send code: offer to keep them as a
    // contact, named from the display name they set.
    if (canAddSenderAsContact(item)) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pmd-receive-row-join pmd-receive-row-add-contact';
      add.textContent = 'Add contact';
      add.title = `Add ${item.senderName || 'the person who invited you'} to your contacts`;
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        void addSenderAsContact(item).then((added) => {
          if (added) add.remove();
        });
      });
      row.appendChild(add);
    }

    const joiner = collabEnabled() ? collabInviteJoiner() : null;
    const joinButton = (code: string, view: boolean): HTMLButtonElement => {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'pmd-receive-row-join';
      join.textContent = view ? 'Watch' : 'Join';
      join.title = view
        ? 'Watch the session live (view only \u2014 no editing)'
        : 'Join the collaboration session';
      join.addEventListener('click', (e) => {
        e.stopPropagation();
        // Consume the invite only when the join actually lands: a cancelled
        // slot pick, an unreachable/filtered relay, or a balked overwrite
        // prompt must not burn the share code (the host would have to
        // re-invite for every retry). A dead room (session ended) reports
        // true from the flow so the useless row still clears.
        // Watching uses up only the watch invite: Join stays on the row.
        void joiner!(code).then((joined) => {
          if (!joined) return;
          for (const it of room.items) {
            const isView = parseRoomInvite(it)?.shareCode.startsWith('cmview') ?? false;
            if (!view || isView) void inboxStore.remove(it.id);
          }
        });
      });
      return join;
    };
    if (joiner) {
      if (room.edit) row.appendChild(joinButton(room.edit, false));
      if (room.view) row.appendChild(joinButton(room.view, true));
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pmd-dropzone-row-delete';
    del.title = 'Remove';
    del.setAttribute('aria-label', 'Remove');
    setIcon(del, 'close');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeRoom(room);
    });
    row.appendChild(del);

    return row;
  }

  // ---- Drag-out / insert (mirrors the dropzone) ---------------------

  private onDragOutPointerMove = (e: PointerEvent): void => {
    const src = this.dragOutSource;
    if (!src) return;
    if (!src.started) {
      const dx = e.clientX - src.startX;
      const dy = e.clientY - src.startY;
      if (dx * dx + dy * dy < 16) return;
      src.started = this.beginDragOut(src.item);
      if (!src.started) {
        this.endDragOut();
        return;
      }
    }
    dragController.setPointer(e.clientX, e.clientY);
    dragController.dispatchHit(e.clientX, e.clientY);
  };

  private onDragOutPointerUp = (e: PointerEvent): void => {
    const src = this.dragOutSource;
    if (!src) return;
    if (src.started) {
      dragController.commit({ copy: true });
    } else {
      this.insertItem(src.item, src.altKey || e.altKey);
    }
    this.endDragOut();
  };

  private beginDragOut(item: InboxItem): boolean {
    const view = this.getFocusedView();
    if (!view) return false;
    let slice: Slice;
    try {
      slice = checkedSliceFromJSON(item.sliceJson);
    } catch {
      return false;
    }
    const type = item.type || 'dropzone';
    const dragItem: DragItem = {
      from: 0,
      to: 0,
      id: null,
      type,
      level: dropzoneDragLevel(type),
      label: item.label,
      prebuilt: slice,
    };
    dragController.begin({ view, items: [dragItem], virtual: true });
    return true;
  }

  private insertItem(item: InboxItem, atEnd: boolean): void {
    const view = this.getFocusedView();
    if (!view) {
      // No visible destination: the home screen covers the doc, or the
      // workspace is empty. Say so instead of silently doing nothing —
      // the item stays in the inbox for when a doc is open.
      showToast(RECEIVE_NEEDS_DOC_MESSAGE);
      return;
    }
    insertReceivedItem(view, item, atEnd);
  }

  private endDragOut(): void {
    if (!this.dragOutSource) return;
    window.removeEventListener('pointermove', this.onDragOutPointerMove);
    window.removeEventListener('pointerup', this.onDragOutPointerUp);
    this.dragOutSource = null;
  }

  private onDocumentPointerDown = (e: PointerEvent): void => {
    if (!this.open) return;
    // A modal on top (the card preview opened from a row) takes the pointer:
    // its Close button must not collapse the list the user is browsing.
    if (isAnyOverlayOpen()) return;
    const t = e.target as Node | null;
    if (!t) return;
    if (this.root.contains(t)) return;
    this.setOpen(false);
  };
}

/** True when `item` names a sender code that isn't you and isn't already
 *  one of your contacts. */
export function canAddSenderAsContact(item: Pick<InboxItem, 'senderCode'>): boolean {
  return canAddContact(item.senderCode);
}

/** Save the sender of `item` as a contact, asking for the name (pre-filled
 *  with the display name they send under). Resolves true when added. */
export function addSenderAsContact(item: Pick<InboxItem, 'senderCode' | 'senderName'>): Promise<boolean> {
  return addContact(item.senderCode, item.senderName);
}

/** Prefer your local nickname for the sender, then their self-declared
 *  name, then a short form of their code. */
export function resolveSender(item: InboxItem): string {
  if (item.senderCode) {
    const partner = settings
      .get('pairingPartners')
      .find((p) => p.code && p.code === item.senderCode);
    if (partner?.name) return item.via ? `${partner.name} · ${item.via}` : partner.name;
  }
  if (item.senderName) return item.via ? `${item.senderName} · ${item.via}` : item.senderName;
  if (item.senderCode) return `…${item.senderCode.slice(-4)}`;
  return 'Unknown sender';
}

export function relTime(ts: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

/** Open the most-recently-received card in the preview (the same
 *  preview a row's Preview button opens) without inserting anything —
 *  the keyboard twin of Insert Received Card. False when the inbox is
 *  empty or the payload cannot be rebuilt (the preview toasts for the
 *  latter itself). Works with the home screen up: nothing is written. */
export const NOTHING_RECEIVED_MESSAGE = 'Nothing received yet.';
export function previewMostRecentReceived(): boolean {
  const item = inboxStore.list().at(-1);
  if (!item) {
    showToast(NOTHING_RECEIVED_MESSAGE);
    return false;
  }
  return openCardPreview({
    title: item.label,
    subtitle: `${resolveSender(item)} · ${relTime(item.receivedAt)}`,
    sliceJson: item.sliceJson,
  });
}

// ---- Session invite grouping ---------------------------------------

/** Every invite to one session (room), newest first. */
export interface SessionRoom {
  roomId: string;
  title: string;
  /** Newest edit (share) code, if any invite lets you edit. */
  edit: string | null;
  /** Newest view (spectate) code, if any invite lets you watch. */
  view: string | null;
  newest: InboxItem;
  items: InboxItem[];
}

const roomIdOf = (code: string): string => code.split('.')[1] ?? code;

/** Group the inbox's session invites by room, newest room first. A room
 *  invited to twice (re-sent, or by two teammates) is one row. */
export function groupSessionInvites(items: readonly InboxItem[]): SessionRoom[] {
  const byRoom = new Map<string, SessionRoom>();
  const sorted = [...items].sort((a, b) => b.receivedAt - a.receivedAt);
  for (const it of sorted) {
    const inv = parseRoomInvite(it);
    if (!inv) continue;
    const id = roomIdOf(inv.shareCode);
    let room = byRoom.get(id);
    if (!room) {
      room = { roomId: id, title: inv.title, edit: null, view: null, newest: it, items: [] };
      byRoom.set(id, room);
    }
    room.items.push(it);
    if (!room.title && inv.title) room.title = inv.title;
    if (inv.shareCode.startsWith('cmview')) room.view ??= inv.shareCode;
    else room.edit ??= inv.shareCode;
  }
  return [...byRoom.values()];
}

/** The badge's total: each session counts once, each card once. */
export function inboxDisplayCount(items: readonly InboxItem[]): number {
  const rooms = groupSessionInvites(items);
  const invites = rooms.reduce((n, r) => n + r.items.length, 0);
  return items.length - invites + rooms.length;
}

/** A session invite sent to a group you're in (the sender picked a group,
 *  not you): listed, but never "new". In a round many teams' sessions
 *  arrive this way. */
export function isGroupInvite(it: InboxItem): boolean {
  return !!it.via && parseRoomInvite(it) !== null;
}

/** A session with an unread invite sent to you by name. */
function roomUnread(room: SessionRoom): boolean {
  return room.items.some((it) => !it.read && !isGroupInvite(it));
}

/** The badge's "N new": unread cards, plus sessions with an unread invite
 *  sent to you by name (each once). Group invites don't count. */
export function inboxDisplayUnread(items: readonly InboxItem[]): number {
  const rooms = groupSessionInvites(items);
  const cards = items.filter((it) => !it.read && !parseRoomInvite(it)).length;
  return cards + rooms.filter(roomUnread).length;
}

function prefetchRoom(room: SessionRoom): void {
  // Eagerly prefetch the room's encrypted seed (§4.1) so accepting
  // this invite later — offline — still joins. Fire-and-forget; the
  // module is light (no wasm) and dedupes/staleness-checks itself.
  if (!collabEnabled()) return;
  const code = room.edit ?? room.view;
  if (!code) return;
  void import('../collab/collab-prefetch.js').then((m) => m.prefetchInviteSeed(code));
}

/** Remove a session's invites and its prefetched seed (a declined invite). */
function removeRoom(room: SessionRoom): void {
  for (const it of room.items) void inboxStore.remove(it.id);
  void deletePrefetch(room.roomId);
}
