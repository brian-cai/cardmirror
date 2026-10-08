/**
 * Web Worker that runs the full Word import (`fromDocxFull`) for opening a
 * document, off the renderer thread. See docx-open.ts for the client.
 *
 * Protocol: { id, bytes, cache? } →
 *   { id, ok: true, docJson, threads, docId } | { id, ok: false, error }
 * With `cache`, a second message follows the reply: { id, cacheJson }, the
 * open cache's bytes for this document (open-cache-codec.ts), transferred.
 * It is built after the reply is posted, so the open never waits for it.
 */

import { fromDocxFull } from '../import/index.js';
import { encodeOpenResult } from '../import/open-cache-codec.js';

const post = (message: unknown, transfer: Transferable[] = []): void =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);

self.onmessage = (e: MessageEvent): void => {
  const req = e.data as { id: number; bytes: Uint8Array; cache?: boolean } | null;
  if (!req || typeof req.id !== 'number') return;
  void (async () => {
    try {
      const { doc, threads, docId } = await fromDocxFull(req.bytes);
      post({ id: req.id, ok: true, docJson: doc.toJSON(), threads, docId });
      if (req.cache) {
        const cacheJson = encodeOpenResult({ doc, threads, docId });
        post({ id: req.id, cacheJson }, [cacheJson.buffer]);
      }
    } catch (err) {
      post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
