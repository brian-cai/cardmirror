/**
 * Web Worker that builds a .docx (`toDocx`: XML generation + zip) for
 * saving, off the renderer thread. See docx-save.ts for the client.
 *
 * Protocol: { id, docJson, opts } → { id, ok: true, bytes } | { id, ok: false, error }
 */

import { toDocx } from '../export/index.js';
import { schema } from '../schema/index.js';

const post = (message: unknown, transfer?: Transferable[]): void =>
  (self as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(message, transfer);

self.onmessage = (e: MessageEvent): void => {
  const req = e.data as { id: number; docJson: unknown; opts: Parameters<typeof toDocx>[1] } | null;
  if (!req || typeof req.id !== 'number') return;
  void (async () => {
    try {
      const bytes = await toDocx(schema.nodeFromJSON(req.docJson), req.opts);
      post({ id: req.id, ok: true, bytes }, [bytes.buffer]);
    } catch (err) {
      post({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
