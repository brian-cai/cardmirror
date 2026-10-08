/**
 * Main-process side of the Word open cache (doc-cache.ts): the IPC the
 * renderer's open path uses, and the background pass that re-converts
 * popular files after they change on disk.
 *
 * The renderer owns the setting (Settings → Workspace → "Open big Word
 * files faster") and pushes it here. A window's first open can come before
 * that push, so lookups are served unless a window has said the cache is
 * off; the background pass waits for an explicit on. Turning it off
 * deletes the cache. Unpackaged (dev)
 * builds keep it off, since their importer changes without a version bump,
 * unless CARDMIRROR_DOC_CACHE=1.
 */

import { app, ipcMain, utilityProcess } from 'electron';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createDocCache, type DocCache } from './doc-cache.js';

/** Total size of the gzipped entries. */
const MAX_CACHE_BYTES = 500 * 1024 * 1024;
/** How many of the most-opened files the background pass keeps fresh. */
const PREWARM_FILES = 10;
const PREWARM_FIRST_DELAY_MS = 60_000;
const PREWARM_INTERVAL_MS = 15 * 60_000;
/** A conversion that hasn't answered by now is abandoned. */
const PREWARM_FILE_TIMEOUT_MS = 120_000;

const buildAllows = app.isPackaged || process.env['CARDMIRROR_DOC_CACHE'] === '1';

let cachePromise: Promise<DocCache> | null = null;
function cache(): Promise<DocCache> {
  cachePromise ??= createDocCache({
    root: path.join(app.getPath('userData'), 'doc-cache'),
    version: app.getVersion(),
    maxBytes: MAX_CACHE_BYTES,
  });
  return cachePromise;
}

/** null until a window pushes the setting. */
let enabled: boolean | null = null;
const servesRequests = (): boolean => buildAllows && enabled !== false;
let prewarmTimer: ReturnType<typeof setTimeout> | null = null;

function isDocxPath(p: unknown): p is string {
  return typeof p === 'string' && path.isAbsolute(p) && /\.docx$/i.test(p);
}

async function setEnabled(on: boolean): Promise<void> {
  const next = on && buildAllows;
  if (next === enabled) return;
  const wasOff = enabled === false;
  enabled = next;
  if (enabled) {
    schedulePrewarm(PREWARM_FIRST_DELAY_MS);
  } else {
    if (prewarmTimer) clearTimeout(prewarmTimer);
    prewarmTimer = null;
    if (buildAllows && !wasOff) await (await cache()).clear();
  }
}

function schedulePrewarm(delayMs: number): void {
  if (prewarmTimer) clearTimeout(prewarmTimer);
  prewarmTimer = setTimeout(() => {
    prewarmTimer = null;
    void prewarmPass()
      .catch((err) => console.warn('[doc-cache] background pass failed:', err))
      .finally(() => {
        if (enabled) schedulePrewarm(PREWARM_INTERVAL_MS);
      });
  }, delayMs);
  prewarmTimer.unref?.();
}

type ServiceReply =
  | { id: number; ok: true; notDocx: true }
  | { id: number; ok: true; notDocx?: undefined; hash: string; mtimeMs: number; size: number; json: Uint8Array | null }
  | { id: number; ok: false; error: string };

/** Re-convert the popular files whose size or mtime moved since their
 *  last conversion (or that have no entry yet). One short-lived service
 *  per pass, killed at the end so its memory goes back right away. */
async function prewarmPass(): Promise<void> {
  if (!enabled) return;
  const c = await cache();
  const stale: string[] = [];
  for (const cand of c.popular(PREWARM_FILES)) {
    let st;
    try {
      st = await fsp.stat(cand.path);
    } catch {
      continue; // moved or deleted
    }
    const fresh =
      cand.hash !== undefined && c.has(cand.hash) && cand.mtimeMs === st.mtimeMs && cand.size === st.size;
    if (!fresh) stale.push(cand.path);
  }
  if (stale.length === 0) return;

  const svc = utilityProcess.fork(path.join(__dirname, 'doc-cache-service.cjs'), [], {
    serviceName: 'cardmirror-doc-cache',
  });
  let nextId = 1;
  const waiters = new Map<number, (r: ServiceReply | null) => void>();
  svc.on('message', (msg: ServiceReply) => {
    waiters.get(msg.id)?.(msg);
    waiters.delete(msg.id);
  });
  svc.on('exit', () => {
    for (const w of waiters.values()) w(null);
    waiters.clear();
  });
  try {
    for (const filePath of stale) {
      if (!enabled) break;
      const id = nextId++;
      const reply = await new Promise<ServiceReply | null>((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          resolve(null);
        }, PREWARM_FILE_TIMEOUT_MS);
        waiters.set(id, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        svc.postMessage({ id, path: filePath, skip: c.hashes() });
      });
      if (!reply) break; // timed out or the service died: try again next pass
      if (!reply.ok) {
        console.warn('[doc-cache] could not pre-convert', filePath, reply.error);
        continue;
      }
      if (reply.notDocx) continue;
      if (reply.json) await c.put(reply.hash, reply.json);
      c.noteFile(filePath, { mtimeMs: reply.mtimeMs, size: reply.size, hash: reply.hash });
    }
  } finally {
    svc.kill();
    await c.flush();
  }
}

export function registerDocCacheIpc(): void {
  ipcMain.handle('host:set-doc-cache-enabled', async (_e, on: unknown) => {
    await setEnabled(on === true);
  });
  ipcMain.handle('host:doc-cache-get', async (_e, hash: unknown) => {
    if (!servesRequests() || typeof hash !== 'string') return null;
    return (await cache()).get(hash);
  });
  ipcMain.handle('host:doc-cache-put', async (_e, hash: unknown, json: unknown) => {
    if (!servesRequests() || typeof hash !== 'string' || !(json instanceof Uint8Array)) return;
    await (await cache()).put(hash, json);
  });
  ipcMain.handle('host:doc-cache-note-open', async (_e, filePath: unknown) => {
    if (!servesRequests() || !isDocxPath(filePath)) return;
    (await cache()).noteOpen(filePath);
  });
  app.on('will-quit', () => {
    if (cachePromise) void cachePromise.then((c) => c.flush());
  });
}
