/**
 * The bytes an opened Word file travels as after conversion: UTF-8 JSON of
 * { doc, threads, docId }.
 *
 * The docx-open worker sends these back to the window (a transferred
 * buffer, instead of structured-cloning the doc JSON, which costs about the
 * same), and the same bytes are what the open cache stores (see
 * apps/desktop/src/doc-cache.ts). The background pre-converter writes them
 * too, so all three must agree on the shape, and this module is the one
 * place it is defined.
 */

import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../schema/index.js';
import type { Thread } from '../editor/comments-plugin.js';

export interface OpenResult {
  doc: PMNode;
  threads: Thread[];
  docId: string | null;
}

/** Bump when the stored shape changes; entries carrying another value are
 *  ignored (the file is converted again). */
const OPEN_CACHE_FORMAT = 1;

export function encodeOpenResult(result: OpenResult): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      format: OPEN_CACHE_FORMAT,
      doc: result.doc.toJSON(),
      threads: result.threads,
      docId: result.docId,
    }),
  );
}

/** Rebuild the doc. Throws on anything malformed, including a doc that
 *  doesn't satisfy the schema, so a bad cache entry is never mounted. */
export function decodeOpenResult(bytes: Uint8Array): OpenResult {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
    format?: unknown;
    doc?: unknown;
    threads?: unknown;
    docId?: unknown;
  };
  if (parsed.format !== OPEN_CACHE_FORMAT) throw new Error('open cache: unknown format');
  const doc = schema.nodeFromJSON(parsed.doc);
  doc.check();
  return {
    doc,
    threads: Array.isArray(parsed.threads) ? (parsed.threads as Thread[]) : [],
    docId: typeof parsed.docId === 'string' ? parsed.docId : null,
  };
}

/** SHA-256 of the file's bytes, lowercase hex: the cache key. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
