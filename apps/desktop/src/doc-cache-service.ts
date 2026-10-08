/**
 * Background pre-converter for the open cache — utilityProcess entry.
 *
 * Main forks this for one batch of popular files (doc-cache.ts `popular`)
 * that changed since they were last converted, sends one request per
 * file, and kills it when the batch is done, so a big conversion's memory
 * is handed back right away. Reading the file also makes Dropbox / OneDrive
 * download an online-only file, which is often the slowest part of a
 * first open.
 *
 * Protocol (main → service over parentPort):
 *   { id, path, skip: string[] }   skip = hashes already cached
 * → { id, ok: true, hash, mtimeMs, size, json: Uint8Array | null }
 *     json is null when the hash was in `skip`
 *   | { id, ok: true, notDocx: true }   (e.g. a password-protected file)
 *   | { id, ok: false, error }
 *
 * Bundled by esbuild (build:service) because it imports the importer from
 * src/, outside the desktop tsc build's rootDir.
 */

import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { fromDocxFull } from '../../../src/import/index.js';
import { encodeOpenResult } from '../../../src/import/open-cache-codec.js';

interface ParentPortLike {
  on(event: 'message', handler: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) {
  console.error('[doc-cache-service] no parentPort; exiting');
  process.exit(1);
}

/** A .docx is a zip ("PK\x03\x04"); a password-protected one is an OLE
 *  compound file and must never be cached. */
function looksLikeZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

let queue: Promise<void> = Promise.resolve();

parentPort.on('message', (e) => {
  const req = e.data as { id?: unknown; path?: unknown; skip?: unknown };
  if (typeof req?.id !== 'number' || typeof req.path !== 'string') return;
  const { id, path: filePath } = req as { id: number; path: string };
  const skip = new Set(Array.isArray(req.skip) ? (req.skip as string[]) : []);
  // One conversion at a time: they are big, and this is idle-time work.
  queue = queue.then(async () => {
    try {
      const stat = await fsp.stat(filePath);
      const bytes = new Uint8Array(await fsp.readFile(filePath));
      if (!looksLikeZip(bytes)) {
        parentPort.postMessage({ id, ok: true, notDocx: true });
        return;
      }
      const hash = createHash('sha256').update(bytes).digest('hex');
      const json = skip.has(hash) ? null : encodeOpenResult(await fromDocxFull(bytes));
      parentPort.postMessage({ id, ok: true, hash, mtimeMs: stat.mtimeMs, size: stat.size, json });
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
});
