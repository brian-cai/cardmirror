// @vitest-environment node
/**
 * Past sessions (Join dialog): a history file carries who and what the
 * session was (`info`, before the snapshot), the header-only listing reads
 * it, and junk in it is dropped.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readHistoryHeader, sanitizeHistoryInfo } from '../../apps/desktop/src/session-history-file.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-history-info-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('history info', () => {
  it('the header listing carries info written before the snapshot', async () => {
    const info = {
      role: 'participant',
      startedBy: 'Sam',
      people: ['Brian', 'Sam', 'Jo'],
      fileName: 'Aff blocks.cmir',
      filePath: '/Users/x/Aff blocks.cmir',
    };
    const file = path.join(dir, 'r.cmir-history');
    await fs.writeFile(
      file,
      JSON.stringify({
        v: 1,
        roomId: 'room-1',
        docTitle: 'Aff blocks - Sam',
        startedAt: 1000,
        updatedAt: 2000,
        changeTimes: [],
        info,
        snapshotB64: Buffer.alloc(200_000, 7).toString('base64'),
      }),
    );
    const header = await readHistoryHeader(file);
    expect(header?.info).toEqual(info);
    expect(header?.docTitle).toBe('Aff blocks - Sam');
  });

  it('a file from before info existed lists without it', async () => {
    const file = path.join(dir, 'old.cmir-history');
    await fs.writeFile(
      file,
      JSON.stringify({ v: 1, roomId: 'r', docTitle: 'T', startedAt: 1, updatedAt: 2, changeTimes: [], snapshotB64: 'AAAA' }),
    );
    const header = await readHistoryHeader(file);
    expect(header?.roomId).toBe('r');
    expect(header?.info).toBeUndefined();
  });

  it('drops malformed fields', () => {
    expect(sanitizeHistoryInfo(null)).toBeUndefined();
    expect(sanitizeHistoryInfo({ role: 'admin', people: 'Sam' })).toBeUndefined();
    expect(sanitizeHistoryInfo({ role: 'host', people: ['  Sam ', 3, ''], startedBy: '' })).toEqual({
      role: 'host',
      people: ['Sam'],
    });
  });
});
