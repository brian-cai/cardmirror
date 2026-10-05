// @vitest-environment jsdom
/**
 * Large-document warnings: the size classes, the dialog text, and the
 * join gate — asked with the downloaded sync size BEFORE the import, and
 * a "no" cancels the join with nothing imported.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { RoomsClient } from '../../src/editor/collab/room-client.js';
import { CollabSession, JoinCancelledError } from '../../src/editor/collab/collab-session.js';
import { decodeShareCode } from '../../src/editor/collab/collab-crypto.js';
import {
  docSizeClass,
  syncSizeClass,
  shareWarning,
  joinWarning,
  LARGE_DOC_POSITIONS,
  HUGE_DOC_POSITIONS,
  LARGE_SYNC_BYTES,
  HUGE_SYNC_BYTES,
} from '../../src/editor/collab/large-doc.js';
import { startRoomsMock, type RoomsMock } from './_rooms-mock.js';
import { simpleDoc } from './_loro-helpers.js';

/** A doc of roughly `chars` positions: ~1k-character paragraphs. */
function docOfSize(chars: number) {
  const para = 'x'.repeat(998);
  const n = Math.ceil(chars / 1000);
  return schema.nodes['doc']!.create(
    null,
    Array.from({ length: n }, () => schema.nodes['paragraph']!.create(null, schema.text(para))),
  );
}

describe('size classes and text', () => {
  it('classifies documents by size', () => {
    expect(docSizeClass(simpleDoc('short'))).toBe('normal');
    expect(docSizeClass(docOfSize(LARGE_DOC_POSITIONS))).toBe('large');
    expect(docSizeClass(docOfSize(HUGE_DOC_POSITIONS))).toBe('huge');
    expect(syncSizeClass(LARGE_SYNC_BYTES - 1)).toBe('normal');
    expect(syncSizeClass(LARGE_SYNC_BYTES)).toBe('large');
    expect(syncSizeClass(HUGE_SYNC_BYTES)).toBe('huge');
  });

  it('warns only past the threshold, and says more for huge documents', () => {
    expect(shareWarning(simpleDoc('short'))).toBeNull();
    const large = shareWarning(docOfSize(LARGE_DOC_POSITIONS))!;
    expect(large).toContain('large document (about 200,000 words)');
    expect(large).not.toContain('compact copy');
    expect(shareWarning(docOfSize(HUGE_DOC_POSITIONS))).toContain('compact copy');
    expect(joinWarning(1_000_000)).toBeNull();
    expect(joinWarning(9_000_000)).toContain('about 9 MB to open');
    expect(joinWarning(40_000_000)).toContain('compact copy');
  });
});

describe('join gate', () => {
  let mock: RoomsMock;
  let client: RoomsClient;
  beforeAll(async () => {
    mock = await startRoomsMock();
    client = new RoomsClient({ baseUrl: () => mock.url, token: () => mock.token });
  });
  afterAll(async () => {
    await mock.close();
  });

  it('asks with the sync size before importing; no cancels, yes joins', async () => {
    const { shareCode } = await CollabSession.host({ pmDoc: simpleDoc('hello there'), client });
    const code = decodeShareCode(shareCode)!;

    const asked: number[] = [];
    await expect(
      CollabSession.join({
        ...code,
        client,
        confirmLargeJoin: async (bytes) => {
          asked.push(bytes);
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(JoinCancelledError);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(0);

    let calls = 0;
    const joined = await CollabSession.join({
      ...code,
      client,
      confirmLargeJoin: async () => {
        calls++;
        return true;
      },
    });
    expect(calls).toBe(1);
    expect(JSON.stringify(joined.loroDoc.toJSON())).toContain('hello there');
    await joined.stop();
  });
});
