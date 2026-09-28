/**
 * Web Worker that runs the full Word import (`fromDocxFull`) for opening a
 * document, off the renderer thread. See docx-open.ts for the client.
 *
 * Protocol: { id, bytes } →
 *   { id, ok: true, docJson, threads, docId } | { id, ok: false, error }
 */

import { fromDocxFull } from '../import/index.js';

const post = (message: unknown): void =>
  (self as unknown as { postMessage(m: unknown): void }).postMessage(message);

self.onmessage = (e: MessageEvent): void => {
  const req = e.data as { id: number; bytes: Uint8Array } | null;
  if (!req || typeof req.id !== 'number') return;
  void (async () => {
    try {
      const { doc, threads, docId } = await fromDocxFull(req.bytes);
      post({ id: req.id, ok: true, docJson: doc.toJSON(), threads, docId });
    } catch (err) {
      post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
