// @vitest-environment jsdom
/**
 * Team sessions through the real collab UI flows: Start lists the session
 * (with the per-session "Don't list" opt-out), a join request shows the
 * status-bar prompt, Approve sends the normal invite card through the
 * card-sharing send path and deletes the request, End takes the listing
 * down before ending the room — and a relay without the extension sees
 * only the discovery GET.
 *
 * The rooms mock serves the base protocol; the extension's routes are
 * served by a small fake in front of it (fetch stub).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { settings } from '../../src/editor/settings.js';
import * as collabUi from '../../src/editor/collab/collab-ui.js';
import { collabPluginsFor, tagCollabTransaction } from '../../src/editor/collab/collab-hooks.js';
import { readModePlugin } from '../../src/editor/read-mode-plugin.js';
import { __resetTeamSessionsForTests, buildJoinRequestPayload, routingIdFor } from '../../src/editor/collab/team-sessions.js';
import { __resetJoinRequestsUiForTests } from '../../src/editor/collab/team-sessions-ui.js';
import { generateTeamKey, openTeamBlob, sealTeamBlob } from '../../src/editor/pairing/team-key.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { settle, simpleDoc } from './_loro-helpers.js';

const OWNER = 'team-flow-doc';
const ALEX = 'cmk1.' + Buffer.alloc(32, 9).toString('base64url');
const ME = 'cmk1.' + Buffer.alloc(32, 3).toString('base64url');
const KEY = generateTeamKey();

let mock: RoomsMock;
const realFetch = globalThis.fetch;
const ext = {
  supported: true,
  log: [] as string[],
  listings: new Map<string, string>(),
  requests: new Map<string, { requestId: string; blob: string; createdAt: number }[]>(),
};
const pairingSend = vi.fn(async (_p: { recipientCodes: string[]; item: { type: string; sliceJson: unknown } }) => ({
  ok: 1,
  fail: 0,
}));

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The extension's routes; everything else goes to the rooms mock. */
const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.slice(new URL(mock.url).pathname.length);
  const method = init?.method ?? 'GET';
  const isExt = /^\/(ext\/|team-sessions$|rooms\/[^/]+\/(listing|join-requests))/.test(path);
  if (isExt) ext.log.push(`${method} ${path}`);
  else if (method === 'DELETE' && /^\/rooms\/[^/]+$/.test(path)) ext.log.push(`${method} ${path}`);
  if (!isExt) return realFetch(input, init);
  if (path === '/ext/team-sessions/v1') {
    return ext.supported ? json(200, { v: 1, maxBlobBytes: 4096, requestTtlSeconds: 86400 }) : json(404, { detail: 'Not Found' });
  }
  const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { blob: string }) : null;
  let m = /^\/rooms\/([^/]+)\/listing$/.exec(path);
  if (m) {
    if (method === 'PUT') ext.listings.set(m[1]!, body!.blob);
    else ext.listings.delete(m[1]!);
    return json(204);
  }
  if (path === '/team-sessions') {
    return json(200, {
      sessions: [...ext.listings].map(([roomId, blob]) => ({ roomId, blob, updatedAt: 1, lastActivity: Date.now(), participants: 1 })),
    });
  }
  m = /^\/rooms\/([^/]+)\/join-requests(?:\/(.+))?$/.exec(path);
  if (m) {
    const list = ext.requests.get(m[1]!) ?? [];
    if (method === 'DELETE') {
      ext.requests.set(m[1]!, list.filter((r) => r.requestId !== m![2]));
      return json(204);
    }
    return json(200, { requests: list });
  }
  return json(404);
}) as typeof fetch;

function mkView(): EditorView {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const view: EditorView = new EditorView(el, {
    state: EditorState.create({ doc: simpleDoc('team prep'), plugins: [readModePlugin, ...collabPluginsFor(OWNER)] }),
    dispatchTransaction(tx) {
      tagCollabTransaction(tx);
      view.updateState(view.state.apply(tx));
    },
  });
  return view;
}

function deps(view: { current: EditorView }) {
  return {
    getView: () => view.current,
    getOwnerUid: () => OWNER,
    refreshPlugins: () => {
      view.current.updateState(view.current.state.reconfigure({ plugins: [readModePlugin, ...collabPluginsFor(OWNER)] }));
    },
    newSessionDoc: () => true,
  };
}

function button(label: string, root: ParentNode = document): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
}

async function start(d: ReturnType<typeof deps>, opts: { dontList?: boolean } = {}): Promise<string> {
  let shareCode = '';
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (t: string) => ((shareCode = t), Promise.resolve()) },
  });
  const p = collabUi.startSessionFlow(d);
  await vi.waitFor(() => expect(document.querySelector('.pmd-text-prompt-dialog')).not.toBeNull());
  await settle();
  const box = document.querySelector<HTMLInputElement>('.pmd-text-prompt-check input');
  if (opts.dontList) {
    box!.checked = true;
    box!.dispatchEvent(new Event('change'));
  }
  button('Start Session').click();
  await p;
  return shareCode;
}

async function end(d: ReturnType<typeof deps>): Promise<void> {
  const p = collabUi.endSessionFlow(d);
  await settle();
  button('End Session').click();
  await p;
}

beforeAll(async () => {
  mock = await startRoomsMock();
  (window as unknown as { electronAPI?: unknown }).electronAPI = { pairingSend };
  localStorage.setItem('pmd-collab', '1');
  settings.set('pairingRelayUrl', mock.url);
  settings.set('pairingRelayToken', mock.token);
  settings.set('pairingEnabled', true);
  settings.set('pairingOwnCode', ME);
  settings.set('pairingDisplayName', 'Sam');
  const chip = document.createElement('div');
  chip.id = 'collab-chip';
  chip.hidden = true;
  document.body.appendChild(chip);
  vi.stubGlobal('fetch', fetchStub);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await mock.close();
  localStorage.removeItem('pmd-collab');
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

beforeEach(() => {
  // Invites go out at once here (the undo window has its own test).
  settings.set('sendUndoSeconds', 0);
  __resetTeamSessionsForTests();
  __resetJoinRequestsUiForTests();
  ext.supported = true;
  ext.log = [];
  ext.listings.clear();
  ext.requests.clear();
  pairingSend.mockClear();
  settings.set('teamSessionsKey', KEY);
  settings.set('teamSessionsOpen', false);
});

describe('team sessions in the session flows', () => {
  it('start lists the session; a request is approved with the invite card; end unlists first', async () => {
    const view = { current: mkView() };
    const d = deps(view);
    document.title = 'Aff K — CardMirror';
    const shareCode = await start(d);
    const roomId = collabUi.activeSession()!.roomId;
    await vi.waitFor(() => expect(ext.listings.has(roomId)).toBe(true));
    expect(await openTeamBlob(KEY, ext.listings.get(roomId)!)).toEqual({
      v: 1,
      name: 'Aff K - Sam',
      startedBy: 'Sam',
      mode: 'request',
      client: expect.stringMatching(/^cardmirror-xtgg\//),
    });

    // Alex asks to join.
    const blob = await sealTeamBlob(
      KEY,
      buildJoinRequestPayload({ name: 'Alex', recipientCode: await routingIdFor(ALEX), publicKey: ALEX }),
    );
    ext.requests.set(roomId, [{ requestId: 'rq1', blob, createdAt: 1 }]);
    const strip = await vi.waitFor(
      () => {
        const el = document.getElementById('team-join-requests');
        expect(el?.hidden).toBe(false);
        return el!;
      },
      { timeout: 4000 },
    );
    expect(strip.textContent).toContain('Alex wants to join:');
    // A card above the status bar (BCai's build), not a segment in it.
    expect(strip.parentElement).toBe(document.body);
    expect(strip.classList.contains('pmd-team-join-requests-card')).toBe(true);

    button('Approve', strip).click();
    await vi.waitFor(() => expect(ext.log).toContain(`DELETE /rooms/${roomId}/join-requests/rq1`));
    expect(pairingSend).toHaveBeenCalledOnce();
    const sent = pairingSend.mock.calls[0]![0];
    expect(sent.recipientCodes).toEqual([ALEX]);
    expect(sent.item.type).toBe('room-invite');
    expect((sent.item.sliceJson as { shareCode: string }).shareCode).toBe(shareCode);
    expect(strip.hidden).toBe(true);

    await end(d);
    const unlist = ext.log.indexOf(`DELETE /rooms/${roomId}/listing`);
    const endRoom = ext.log.indexOf(`DELETE /rooms/${roomId}`);
    expect(unlist).toBeGreaterThanOrEqual(0);
    expect(endRoom).toBeGreaterThan(unlist);
    view.current.destroy();
  }, 20_000);

  it('Deny deletes the request without sending anything', async () => {
    const view = { current: mkView() };
    const d = deps(view);
    await start(d);
    const roomId = collabUi.activeSession()!.roomId;
    await vi.waitFor(() => expect(ext.listings.has(roomId)).toBe(true));
    const blob = await sealTeamBlob(
      KEY,
      buildJoinRequestPayload({ name: 'Alex', recipientCode: await routingIdFor(ALEX), publicKey: ALEX }),
    );
    ext.requests.set(roomId, [{ requestId: 'rq2', blob, createdAt: 1 }]);
    const strip = await vi.waitFor(
      () => {
        const el = document.getElementById('team-join-requests');
        expect(el?.hidden).toBe(false);
        return el!;
      },
      { timeout: 4000 },
    );
    button('Deny', strip).click();
    await vi.waitFor(() => expect(ext.log).toContain(`DELETE /rooms/${roomId}/join-requests/rq2`));
    expect(pairingSend).not.toHaveBeenCalled();
    await end(d);
    view.current.destroy();
  }, 20_000);

  it('open mode lists the share code', async () => {
    settings.set('teamSessionsOpen', true);
    const view = { current: mkView() };
    const d = deps(view);
    const shareCode = await start(d);
    const roomId = collabUi.activeSession()!.roomId;
    await vi.waitFor(() => expect(ext.listings.has(roomId)).toBe(true));
    expect(await openTeamBlob(KEY, ext.listings.get(roomId)!)).toMatchObject({ mode: 'open', shareCode });
    await end(d);
    view.current.destroy();
  }, 20_000);

  it('"Don’t list this session" lists nothing', async () => {
    const view = { current: mkView() };
    const d = deps(view);
    await start(d, { dontList: true });
    await settle();
    expect(ext.log.some((l) => l.startsWith('PUT'))).toBe(false);
    await end(d);
    expect(ext.log.some((l) => l.includes('/listing'))).toBe(false);
    view.current.destroy();
  }, 20_000);

  it('a relay without the extension: no opt-out shown, only the discovery GET', async () => {
    ext.supported = false;
    const view = { current: mkView() };
    const d = deps(view);
    const p = collabUi.startSessionFlow(d);
    await vi.waitFor(() => expect(document.querySelector('.pmd-text-prompt-dialog')).not.toBeNull());
    expect(document.querySelector('.pmd-text-prompt-check')).toBeNull();
    button('Start Session').click();
    await p;
    await settle();
    await end(d);
    expect(ext.log.filter((l) => !/^DELETE \/rooms\/[^/]+$/.test(l))).toEqual(['GET /ext/team-sessions/v1']);
    view.current.destroy();
  }, 20_000);

  it('no team key: the extension is never called', async () => {
    settings.set('teamSessionsKey', '');
    const view = { current: mkView() };
    const d = deps(view);
    const p = collabUi.startSessionFlow(d);
    await vi.waitFor(() => expect(document.querySelector('.pmd-text-prompt-dialog')).not.toBeNull());
    expect(document.querySelector('.pmd-text-prompt-check')).toBeNull();
    button('Start Session').click();
    await p;
    await end(d);
    expect(ext.log.filter((l) => !/^DELETE \/rooms\/[^/]+$/.test(l))).toEqual([]);
    view.current.destroy();
  }, 20_000);
});
