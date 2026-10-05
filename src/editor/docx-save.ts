/**
 * Saving a .docx without freezing the window — the counterpart of
 * docx-open.ts.
 *
 * `toDocx` (OOXML generation + zip compression) ran on the renderer thread
 * for every Word save: ~0.5 s on a typical file, several seconds on a
 * tournament masterfile, with the window frozen throughout. Here it runs in
 * a worker (docx-save-worker.ts); only `doc.toJSON()` (a fraction of the
 * cost) stays on this thread, since a node can't cross the boundary.
 *
 * Any worker failure, or a worker that doesn't answer in time, re-runs the
 * export inline, so the caller gets exactly the bytes or error it always
 * did. Hosts without Worker (jsdom tests) take the inline path directly.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { toDocx } from '../export/index.js';

type ExportOpts = NonNullable<Parameters<typeof toDocx>[1]>;
type WorkerReply = { id: number; ok: true; bytes: Uint8Array } | { id: number; ok: false; error: string };

/** How long the worker gets before the save falls back inline: a floor plus
 *  a second per 100k document positions (a 10M-position masterfile: ~2 min). */
export function docxSaveTimeoutMs(docSize: number): number {
  return 30_000 + Math.ceil(docSize / 100_000) * 1_000;
}

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (b: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker in this host');
    worker = new Worker(new URL('./docx-save-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent): void => {
      const msg = e.data as WorkerReply;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.bytes);
      else waiter.reject(new Error(msg.error));
    };
    worker.onerror = (): void => retireWorker('docx save worker failed');
    worker.onmessageerror = (): void => retireWorker('docx save worker reply unreadable');
  } catch {
    worker = null;
  }
  return worker;
}

function retireWorker(reason: string): void {
  for (const [, waiter] of pending) waiter.reject(new Error(reason));
  pending.clear();
  worker?.terminate();
  worker = undefined;
}

/** `toDocx`, off the renderer thread when the host allows. */
export async function toDocxOffThread(doc: PMNode, opts: ExportOpts = {}): Promise<Uint8Array> {
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          if (pending.has(id)) retireWorker('docx save worker timed out');
        }, docxSaveTimeoutMs(doc.nodeSize));
        pending.set(id, {
          resolve: (b) => {
            clearTimeout(timer);
            resolve(b);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        w.postMessage({ id, docJson: doc.toJSON(), opts });
      });
    } catch {
      /* worker died or the export failed there — run it inline below */
    }
  }
  return toDocx(doc, opts);
}
