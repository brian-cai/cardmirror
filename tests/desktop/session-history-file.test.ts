// @vitest-environment node
/**
 * Session history files: the listing reads only the head of each file (the
 * snapshot, most of it, is the last key) and must agree with a full parse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseHistoryEnvelope,
  readHistoryHeader,
} from '../../apps/desktop/src/session-history-file.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-session-history-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Written exactly as main's host:write-history does: JSON.stringify, the
 *  snapshot last. */
async function writeEnvelope(name: string, over: Record<string, unknown> = {}): Promise<string> {
  const env = {
    v: 1,
    roomId: 'room-1',
    docTitle: 'Aff — “Warming” \\ "quoted" ,"snapshotB64":"',
    startedAt: 1000,
    updatedAt: 2000,
    changeTimes: Array.from({ length: 5000 }, (_, i) => ({ peer: 'p', counter: i, at: i })),
    snapshotB64: Buffer.alloc(300_000, 7).toString('base64'),
    ...over,
  };
  const file = path.join(dir, name);
  await fs.writeFile(file, JSON.stringify(env));
  return file;
}

describe('readHistoryHeader', () => {
  it('matches a full parse, past a head chunk of change times and a tricky title', async () => {
    const file = await writeEnvelope('a.cmir-history');
    const text = await fs.readFile(file, 'utf8');
    const full = parseHistoryEnvelope(text)!;
    expect(await readHistoryHeader(file)).toEqual({
      roomId: full.roomId,
      docTitle: full.docTitle,
      startedAt: full.startedAt,
      updatedAt: full.updatedAt,
      sizeBytes: Buffer.byteLength(text),
    });
  });

  it('rejects what a full parse rejects', async () => {
    expect(await readHistoryHeader(await writeEnvelope('b', { snapshotB64: '' }))).toBeNull();
    expect(await readHistoryHeader(await writeEnvelope('c', { v: 2 }))).toBeNull();
    expect(await readHistoryHeader(await writeEnvelope('d', { roomId: '' }))).toBeNull();
    const torn = path.join(dir, 'e');
    await fs.writeFile(torn, '{"v":1,"roomId":"r"');
    expect(await readHistoryHeader(torn)).toBeNull();
  });

  it('falls back to a full parse when the snapshot is not the last key', async () => {
    const file = path.join(dir, 'f');
    await fs.writeFile(
      file,
      JSON.stringify({ snapshotB64: 'AAAA', v: 1, roomId: 'r', startedAt: 1, updatedAt: 2, changeTimes: [] }),
    );
    expect((await readHistoryHeader(file))?.roomId).toBe('r');
  });
});
