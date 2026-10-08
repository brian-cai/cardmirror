/**
 * Open cache for Word files: the converted document, keyed by the bytes.
 *
 * Opening a big .docx spends about a second converting it (unzip, XML
 * parse, import, repair: ~0.75 s for a 4.5 MB 2AC file) and another ~0.3 s
 * shipping the result back to the window. The same team files get opened
 * over and over, unchanged, so the converted document (ProseMirror JSON +
 * comment threads + docId) is kept here, gzipped, under the SHA-256 of
 * the file's bytes. A file whose bytes changed has a new hash and is
 * simply converted again; there is no way to serve a stale copy.
 *
 * Entries live in {root}/{version}/<hash>.json.gz, where `version` is the
 * app version: a new build's importer may convert differently, so an
 * update starts an empty cache (older version folders are deleted on
 * load). The total is capped (least recently used goes first).
 *
 * The cache also remembers which files are opened often (path → recent
 * open times, plus the size / mtime / hash it last saw), so main can
 * re-convert a popular file in the background when it changes on disk
 * (see doc-cache-service.ts). Password-protected files never get here:
 * the renderer skips the cache for anything it decrypted.
 *
 * Pure Node (no `electron` import), so it is unit-tested against temp dirs.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

/** Opens older than this don't count toward a file being popular. */
const POPULAR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Open times kept per file (enough to rank by recent use). */
const MAX_OPENS_PER_FILE = 20;
/** Files remembered for popularity; the least recently opened go first. */
const MAX_TRACKED_FILES = 500;

const HASH_RE = /^[0-9a-f]{64}$/;

export function isDocCacheHash(hash: unknown): hash is string {
  return typeof hash === 'string' && HASH_RE.test(hash);
}

interface EntryMeta {
  /** Gzipped size on disk. */
  bytes: number;
  lastUsed: number;
}

export interface TrackedFile {
  opens: number[];
  mtimeMs?: number;
  size?: number;
  hash?: string;
}

interface IndexFile {
  version: string;
  entries: Record<string, EntryMeta>;
  files: Record<string, TrackedFile>;
}

export interface PrewarmCandidate {
  path: string;
  mtimeMs?: number;
  size?: number;
  hash?: string;
}

export interface DocCache {
  /** The cached JSON bytes for `hash`, or null. Marks the entry used. */
  get(hash: string): Promise<Uint8Array | null>;
  has(hash: string): boolean;
  hashes(): string[];
  /** Store the converted document's JSON bytes under `hash` (replacing
   *  any entry already there). */
  put(hash: string, json: Uint8Array): Promise<void>;
  /** Record that the user opened `filePath`. */
  noteOpen(filePath: string): void;
  /** Record what `filePath` looked like when it was last converted. */
  noteFile(filePath: string, info: { mtimeMs: number; size: number; hash: string }): void;
  /** Files opened at least `minOpens` times in the last 30 days, most
   *  opened first. */
  popular(limit: number, minOpens?: number): PrewarmCandidate[];
  /** Delete every entry (the popularity record goes too). */
  clear(): Promise<void>;
  /** Write the index now (normally debounced). */
  flush(): Promise<void>;
  totalBytes(): number;
}

export interface DocCacheOptions {
  root: string;
  version: string;
  maxBytes: number;
  now?: () => number;
  /** Debounce for index writes; tests pass 0 and call flush(). */
  persistDelayMs?: number;
}

/** A version string safe to use as a folder name. */
function versionDir(version: string): string {
  return version.replace(/[^0-9A-Za-z._-]/g, '_') || 'unknown';
}

export async function createDocCache(opts: DocCacheOptions): Promise<DocCache> {
  const now = opts.now ?? Date.now;
  const vdir = versionDir(opts.version);
  const entryDir = path.join(opts.root, vdir);
  const indexPath = path.join(opts.root, 'index.json');
  const persistDelayMs = opts.persistDelayMs ?? 2_000;

  let index: IndexFile = { version: opts.version, entries: {}, files: {} };
  try {
    const raw = JSON.parse(await fsp.readFile(indexPath, 'utf8')) as Partial<IndexFile>;
    const files = raw.files && typeof raw.files === 'object' ? raw.files : {};
    if (raw.version === opts.version) {
      index = { version: opts.version, entries: raw.entries ?? {}, files };
    } else {
      // New build: its importer may convert differently. Keep who opens
      // what, drop the hashes that pointed at the old entries.
      for (const f of Object.values(files)) delete f.hash;
      index = { version: opts.version, entries: {}, files };
    }
  } catch {
    /* no index yet, or unreadable: start empty */
  }

  await fsp.mkdir(entryDir, { recursive: true });
  // Older versions' entry folders, and entries the index lost track of.
  try {
    for (const d of await fsp.readdir(opts.root, { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== vdir) {
        await fsp.rm(path.join(opts.root, d.name), { recursive: true, force: true });
      }
    }
    for (const name of await fsp.readdir(entryDir)) {
      const hash = name.replace(/\.json\.gz$/, '');
      if (!index.entries[hash]) await fsp.rm(path.join(entryDir, name), { force: true });
    }
  } catch {
    /* best effort */
  }
  for (const hash of Object.keys(index.entries)) {
    if (!isDocCacheHash(hash)) delete index.entries[hash];
  }

  const entryPath = (hash: string): string => path.join(entryDir, `${hash}.json.gz`);

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();
  const writeIndex = (): Promise<void> => {
    const text = JSON.stringify(index);
    writing = writing.then(async () => {
      const tmp = `${indexPath}.tmp`;
      try {
        await fsp.writeFile(tmp, text);
        await fsp.rename(tmp, indexPath);
      } catch (err) {
        console.warn('[doc-cache] index write failed:', err);
      }
    });
    return writing;
  };
  const schedulePersist = (): void => {
    if (persistDelayMs === 0) return;
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void writeIndex();
    }, persistDelayMs);
    persistTimer.unref?.();
  };

  const total = (): number =>
    Object.values(index.entries).reduce((sum, e) => sum + e.bytes, 0);

  const evict = async (keep: string): Promise<void> => {
    let sum = total();
    if (sum <= opts.maxBytes) return;
    const byAge = Object.entries(index.entries)
      .filter(([h]) => h !== keep)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [hash, meta] of byAge) {
      if (sum <= opts.maxBytes) break;
      delete index.entries[hash];
      sum -= meta.bytes;
      await fsp.rm(entryPath(hash), { force: true }).catch(() => {});
    }
  };

  const trackedFile = (filePath: string): TrackedFile => {
    let f = index.files[filePath];
    if (!f) {
      f = { opens: [] };
      index.files[filePath] = f;
      const paths = Object.keys(index.files);
      if (paths.length > MAX_TRACKED_FILES) {
        const last = (p: string): number => index.files[p]!.opens.at(-1) ?? 0;
        paths.sort((a, b) => last(a) - last(b));
        for (const p of paths.slice(0, paths.length - MAX_TRACKED_FILES)) {
          if (p !== filePath) delete index.files[p];
        }
      }
    }
    return f;
  };

  return {
    async get(hash) {
      if (!isDocCacheHash(hash)) return null;
      const meta = index.entries[hash];
      if (!meta) return null;
      try {
        const gz = await fsp.readFile(entryPath(hash));
        const json = await gunzipAsync(gz);
        meta.lastUsed = now();
        schedulePersist();
        return new Uint8Array(json.buffer, json.byteOffset, json.byteLength);
      } catch {
        // Missing or corrupt on disk: forget it; the open converts as usual.
        delete index.entries[hash];
        schedulePersist();
        return null;
      }
    },
    has: (hash) => isDocCacheHash(hash) && !!index.entries[hash],
    hashes: () => Object.keys(index.entries),
    async put(hash, json) {
      if (!isDocCacheHash(hash)) return;
      // An existing entry is replaced: the renderer only sends one after a
      // miss, or after the stored copy failed to load.
      const gz = await gzipAsync(json, { level: 6 });
      if (gz.byteLength > opts.maxBytes) return;
      const tmp = `${entryPath(hash)}.tmp`;
      await fsp.writeFile(tmp, gz);
      await fsp.rename(tmp, entryPath(hash));
      index.entries[hash] = { bytes: gz.byteLength, lastUsed: now() };
      await evict(hash);
      // Written now, not debounced: an entry the index doesn't list is
      // deleted at the next launch, and a quit can cut a debounce short.
      if (persistDelayMs !== 0) await writeIndex();
    },
    noteOpen(filePath) {
      if (typeof filePath !== 'string' || filePath === '') return;
      const f = trackedFile(filePath);
      f.opens.push(now());
      if (f.opens.length > MAX_OPENS_PER_FILE) f.opens.splice(0, f.opens.length - MAX_OPENS_PER_FILE);
      schedulePersist();
    },
    noteFile(filePath, info) {
      const f = trackedFile(filePath);
      f.mtimeMs = info.mtimeMs;
      f.size = info.size;
      f.hash = info.hash;
      schedulePersist();
    },
    popular(limit, minOpens = 2) {
      const cutoff = now() - POPULAR_WINDOW_MS;
      return Object.entries(index.files)
        .map(([p, f]) => ({ p, f, recent: f.opens.filter((t) => t >= cutoff) }))
        .filter((x) => x.recent.length >= minOpens)
        .sort((a, b) => b.recent.length - a.recent.length || (b.recent.at(-1) ?? 0) - (a.recent.at(-1) ?? 0))
        .slice(0, limit)
        .map(({ p, f }) => ({ path: p, mtimeMs: f.mtimeMs, size: f.size, hash: f.hash }));
    },
    async clear() {
      index = { version: opts.version, entries: {}, files: {} };
      await fsp.rm(entryDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(entryDir, { recursive: true });
      await writeIndex();
    },
    async flush() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      await writeIndex();
    },
    totalBytes: total,
  };
}
