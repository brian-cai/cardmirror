// @vitest-environment jsdom
/**
 * openDocxOffThread + the open cache: a hit skips the worker, a miss asks
 * the worker for the cache bytes and hands them to main after the reply,
 * and a decrypted file or a disabled setting never touches the cache. The
 * Worker and window.electronAPI are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { toDocx, fromDocxFull } from '../../src/index.js';
import { encodeOpenResult, sha256Hex } from '../../src/import/open-cache-codec.js';

let posted: { id: number; cache?: boolean }[] = [];
let cacheJsonFor: Uint8Array | null = null;

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(req: { id: number; bytes: Uint8Array; cache?: boolean }): void {
    posted.push(req);
    void fromDocxFull(req.bytes).then((r) => {
      this.onmessage?.({ data: { id: req.id, ok: true, docJson: r.doc.toJSON(), threads: r.threads, docId: r.docId } } as MessageEvent);
      if (req.cache) this.onmessage?.({ data: { id: req.id, cacheJson: cacheJsonFor ?? encodeOpenResult(r) } } as MessageEvent);
    });
  }
  terminate(): void {}
}

let store: Map<string, Uint8Array>;
let gets: string[];
let puts: string[];

async function sampleDocx(text = 'Warming is real'): Promise<Uint8Array> {
  const doc = schema.nodes['doc']!.createChecked(null, [
    schema.nodes['card']!.createChecked(null, [
      schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(text)),
      schema.nodes['card_body']!.create(null, schema.text('body text')),
    ]),
  ]);
  return toDocx(doc, {});
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  vi.resetModules();
  posted = [];
  cacheJsonFor = null;
  store = new Map();
  gets = [];
  puts = [];
  vi.stubGlobal('Worker', FakeWorker);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    docCacheGet: async (hash: string) => {
      gets.push(hash);
      return store.get(hash) ?? null;
    },
    docCachePut: async (hash: string, json: Uint8Array) => {
      puts.push(hash);
      store.set(hash, json);
    },
  };
});
afterEach(async () => {
  await settle(); // let a test's deferred store land before the next one's stubs
  vi.unstubAllGlobals();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

async function load() {
  const { openDocxOffThread } = await import('../../src/editor/docx-open.js');
  const { settings } = await import('../../src/editor/settings.js');
  const { wasDecrypted } = await import('../../src/editor/open-encrypted.js');
  return { openDocxOffThread, settings, wasDecrypted };
}

describe('openDocxOffThread with the open cache', () => {
  it('a miss converts in the worker, then stores the result; the next open is a hit with no worker', async () => {
    const { openDocxOffThread, settings } = await load();
    settings.set('docOpenCache', true);
    const bytes = await sampleDocx();
    const hash = await sha256Hex(bytes);

    const first = await openDocxOffThread(bytes);
    expect(first.doc.textContent).toContain('Warming is real');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.cache).toBe(true);
    await settle();
    expect(puts).toEqual([hash]);

    const second = await openDocxOffThread(bytes);
    expect(posted).toHaveLength(1); // no second conversion
    expect(second.doc.toJSON()).toEqual(first.doc.toJSON());
  });

  it('different bytes are a different entry', async () => {
    const { openDocxOffThread, settings } = await load();
    settings.set('docOpenCache', true);
    await openDocxOffThread(await sampleDocx('one'));
    await settle();
    const got = await openDocxOffThread(await sampleDocx('two'));
    expect(got.doc.textContent).toContain('two');
    expect(posted).toHaveLength(2);
  });

  it('a stored copy that fails to load converts as usual and is replaced', async () => {
    const { openDocxOffThread, settings } = await load();
    settings.set('docOpenCache', true);
    const bytes = await sampleDocx();
    const hash = await sha256Hex(bytes);
    store.set(hash, new TextEncoder().encode('{"format":1,"doc":{"type":"nope"}}'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const got = await openDocxOffThread(bytes);
    warn.mockRestore();
    expect(got.doc.textContent).toContain('Warming is real');
    expect(posted).toHaveLength(1);
    await settle();
    expect(puts).toEqual([hash]);
    expect(new TextDecoder().decode(store.get(hash)!)).toContain('Warming is real');
  });

  it('the setting off: no lookup, no store', async () => {
    const { openDocxOffThread, settings } = await load();
    settings.set('docOpenCache', false);
    await openDocxOffThread(await sampleDocx());
    await settle();
    expect(gets).toEqual([]);
    expect(puts).toEqual([]);
    expect(posted[0]!.cache).toBe(false);
  });

  it('bytes from a password prompt are never looked up or stored', async () => {
    const { openDocxOffThread, settings } = await load();
    settings.set('docOpenCache', true);
    const bytes = await sampleDocx();
    // What maybeDecryptForOpen does with a decrypted file.
    const mod = await import('../../src/editor/open-encrypted.js');
    (mod as unknown as { __markDecryptedForTests(b: Uint8Array): void }).__markDecryptedForTests(bytes);
    expect(mod.wasDecrypted(bytes)).toBe(true);
    await openDocxOffThread(bytes);
    await settle();
    expect(gets).toEqual([]);
    expect(puts).toEqual([]);
  });
});
