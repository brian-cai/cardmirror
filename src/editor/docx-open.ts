/**
 * Opening a .docx without freezing the window.
 *
 * `fromDocxFull` (unzip, XML parse, import, repair) is DOM-free and took
 * the renderer thread for the whole parse on every Word open: about a
 * second for a 3.7 MB file, several for a tournament master. Here it runs
 * in a worker (docx-open-worker.ts). The doc comes back as ProseMirror JSON,
 * since a node can't cross the worker boundary, and only `nodeFromJSON`
 * runs on this thread.
 *
 * Any worker failure, a failed import included, re-runs the import inline:
 * the caller then gets exactly the result or error it always did (error
 * classes don't survive a worker's postMessage). Hosts without Worker (jsdom
 * tests) take the inline path directly.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { fromDocxFull } from '../import/index.js';
import { schema } from '../schema/index.js';
import type { Thread } from './comments-plugin.js';

export type DocxOpenResult = { doc: PMNode; threads: Thread[]; docId: string | null };

type WorkerReply =
  | { id: number; ok: true; docJson: unknown; threads: Thread[]; docId: string | null }
  | { id: number; ok: false; error: string };

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, { resolve: (r: WorkerReply & { ok: true }) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    if (typeof Worker === 'undefined') throw new Error('no Worker in this host');
    worker = new Worker(new URL('./docx-open-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent): void => {
      const msg = e.data as WorkerReply;
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg);
      else waiter.reject(new Error(msg.error));
    };
    worker.onerror = (): void => {
      // A dead worker fails everything in flight (each retries inline) and
      // is replaced on the next open.
      for (const [, waiter] of pending) waiter.reject(new Error('docx open worker failed'));
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** `fromDocxFull`, off the renderer thread when the host allows. */
export async function openDocxOffThread(bytes: Uint8Array | ArrayBuffer): Promise<DocxOpenResult> {
  const w = getWorker();
  if (w) {
    try {
      const reply = await new Promise<WorkerReply & { ok: true }>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        // A copy, not a transfer: the caller keeps its bytes (a failed
        // import retries inline on them, and open paths hold them for
        // provenance / disk-baseline checks).
        w.postMessage({ id, bytes });
      });
      return { doc: schema.nodeFromJSON(reply.docJson), threads: reply.threads, docId: reply.docId };
    } catch {
      /* worker died or the import failed there — run it inline below */
    }
  }
  return fromDocxFull(bytes);
}
