/** Word open cache store (apps/desktop/src/doc-cache.ts). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDocCache } from '../../apps/desktop/src/doc-cache.js';

const DAY = 24 * 60 * 60 * 1000;
const h = (c: string): string => c.repeat(64);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array | null): string | null => (b ? new TextDecoder().decode(b) : null);

let root: string;
let clock: number;
const open = (over: { version?: string; maxBytes?: number } = {}) =>
  createDocCache({ root, version: over.version ?? '1.0.0', maxBytes: over.maxBytes ?? 1e9, now: () => clock, persistDelayMs: 0 });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-cache-'));
  clock = 100 * DAY;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('doc cache', () => {
  it('stores and returns the bytes under their hash, and survives a reload', async () => {
    const c = await open();
    expect(await c.get(h('a'))).toBeNull();
    await c.put(h('a'), bytes('{"doc":1}'));
    expect(text(await c.get(h('a')))).toBe('{"doc":1}');
    await c.flush();
    const again = await open();
    expect(text(await again.get(h('a')))).toBe('{"doc":1}');
  });

  it('a put replaces an existing entry (a bad copy gets rewritten)', async () => {
    const c = await open();
    await c.put(h('a'), bytes('old'));
    await c.put(h('a'), bytes('new'));
    expect(text(await c.get(h('a')))).toBe('new');
  });

  it('refuses anything that is not a sha-256 hex key', async () => {
    const c = await open();
    await c.put('../../etc/passwd', bytes('x'));
    expect(fs.readdirSync(path.join(root, '1.0.0'))).toEqual([]);
    expect(await c.get('../x')).toBeNull();
    expect(c.has(h('A'))).toBe(false);
  });

  it('a new app version starts empty, deletes the old entries, and keeps who opens what', async () => {
    const c = await open();
    await c.put(h('a'), bytes('x'));
    c.noteOpen('/f/2ac.docx');
    c.noteOpen('/f/2ac.docx');
    c.noteFile('/f/2ac.docx', { mtimeMs: 1, size: 2, hash: h('a') });
    await c.flush();
    const next = await open({ version: '1.0.1' });
    expect(await next.get(h('a'))).toBeNull();
    expect(fs.existsSync(path.join(root, '1.0.0'))).toBe(false);
    expect(next.popular(10)).toEqual([{ path: '/f/2ac.docx', mtimeMs: 1, size: 2, hash: undefined }]);
  });

  it('evicts least recently used entries past the cap, never the one just stored', async () => {
    const c = await open({ maxBytes: 60 });
    const blob = (n: number): Uint8Array => bytes('x'.repeat(n) + Math.random()); // gzip keeps these tiny but nonzero
    await c.put(h('a'), blob(10));
    clock += 1;
    await c.put(h('b'), blob(10));
    clock += 1;
    await c.get(h('a')); // a is now the more recent
    clock += 1;
    await c.put(h('c'), blob(10));
    expect(c.totalBytes()).toBeLessThanOrEqual(60);
    expect(c.has(h('c'))).toBe(true);
    expect(c.has(h('b'))).toBe(false);
  });

  it('drops an entry whose file went missing', async () => {
    const c = await open();
    await c.put(h('a'), bytes('x'));
    fs.rmSync(path.join(root, '1.0.0', `${h('a')}.json.gz`));
    expect(await c.get(h('a'))).toBeNull();
    expect(c.has(h('a'))).toBe(false);
  });

  it('popular: opened at least twice in the last 30 days, most opened first', async () => {
    const c = await open();
    c.noteOpen('/once.docx');
    for (let i = 0; i < 3; i++) c.noteOpen('/three.docx');
    for (let i = 0; i < 2; i++) c.noteOpen('/two.docx');
    clock -= 40 * DAY;
    for (let i = 0; i < 5; i++) c.noteOpen('/old.docx');
    clock += 40 * DAY;
    expect(c.popular(10).map((p) => p.path)).toEqual(['/three.docx', '/two.docx']);
    expect(c.popular(1).map((p) => p.path)).toEqual(['/three.docx']);
  });

  it('clear deletes everything', async () => {
    const c = await open();
    await c.put(h('a'), bytes('x'));
    c.noteOpen('/a.docx');
    c.noteOpen('/a.docx');
    await c.clear();
    expect(c.has(h('a'))).toBe(false);
    expect(c.popular(10)).toEqual([]);
    expect(fs.readdirSync(path.join(root, '1.0.0'))).toEqual([]);
  });
});
