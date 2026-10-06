// @vitest-environment jsdom
/**
 * Starting a session on a big document: CollabSession.host builds the
 * shared copy in slices (progress + Cancel), creates the relay room only
 * after the local build, deletes it if cancelled during the upload, and
 * hands the binding the seeding mapping so its init doesn't rebuild the
 * document it was seeded from.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import {
  CollabSession,
  SessionStartCancelledError,
  type HostProgress,
} from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import { schema } from '../../src/schema/index.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { mkView, settle, docText } from './_loro-helpers.js';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

let mock: RoomsMock;
let client: RoomsClient;
beforeAll(async () => {
  mock = await startRoomsMock();
  client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
});
afterAll(async () => {
  await mock.close();
});

/** ~`blocks` paragraphs of ~1,000 characters: several build slices. */
function bigDoc(blocks: number) {
  return schema.nodes['doc']!.create(
    null,
    Array.from({ length: blocks }, (_, i) => schema.nodes['paragraph']!.create(null, schema.text(`p${i} ` + 'x'.repeat(1000)))),
  );
}

describe('CollabSession.host progress and cancel', () => {
  it('reports build progress in slices, then packaging, then upload — and the result joins intact', async () => {
    const events: HostProgress[] = [];
    const { session, shareCode } = await CollabSession.host({
      pmDoc: bigDoc(400),
      client,
      onProgress: (p) => events.push({ ...p }),
    });
    const builds = events.filter((e) => e.phase === 'build');
    expect(builds.length).toBeGreaterThan(1);
    expect(builds.map((e) => e.done)).toEqual([...builds.map((e) => e.done)].sort((a, b) => a - b));
    expect(builds.at(-1)!.done).toBe(builds.at(-1)!.total);
    const phases = events.map((e) => e.phase).filter((ph, i, a) => a.indexOf(ph) === i);
    expect(phases).toEqual(['build', 'package', 'upload']);
    const joiner = await CollabSession.join({ ...decodeShareCode(shareCode)!, client });
    expect(JSON.stringify(joiner.loroDoc.toJSON())).toContain('p399 ');
    await joiner.stop();
    await session.stop();
  });

  it('cancelled while building: throws, and no room was ever created', async () => {
    const create = vi.spyOn(client, 'createRoom');
    const ac = new AbortController();
    await expect(
      CollabSession.host({
        pmDoc: bigDoc(400),
        client,
        signal: ac.signal,
        onProgress: (p) => {
          if (p.phase === 'build') ac.abort();
        },
      }),
    ).rejects.toBeInstanceOf(SessionStartCancelledError);
    expect(create).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it('cancelled while uploading: throws and deletes the half-made room', async () => {
    const del = vi.spyOn(client, 'deleteRoom');
    const ac = new AbortController();
    await expect(
      CollabSession.host({
        pmDoc: bigDoc(60),
        client,
        updateByteLimit: 4000, // several upload pieces
        signal: ac.signal,
        onProgress: (p) => {
          if (p.phase === 'upload' && p.done === 1) ac.abort();
        },
      }),
    ).rejects.toBeInstanceOf(SessionStartCancelledError);
    expect(del).toHaveBeenCalledTimes(1);
    del.mockRestore();
  });

  it("the host's binding keeps the very document it was seeded from (no startup rebuild)", async () => {
    const doc = bigDoc(50);
    const { session } = await CollabSession.host({ pmDoc: doc, client });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const view = new EditorView(el, { state: EditorState.create({ doc, plugins: session.plugins() }) });
    await settle();
    expect(view.state.doc).toBe(doc); // not replaced by a rebuilt copy
    // …and local edits still sync.
    view.dispatch(view.state.tr.insertText('SYNCED', 3));
    expect(JSON.stringify(session.loroDoc.toJSON())).toContain('SYNCED');
    view.destroy();
    await session.stop();
    void mkView;
    void docText;
  });
});
