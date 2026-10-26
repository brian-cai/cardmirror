/**
 * Which files main will hand the renderer as CODE.
 *
 * `host:cardcutter-read` and `host:plugin-read-file` return a file's text
 * and the preload runs it in the renderer's main world. Before this check
 * they read any path the renderer named, so a settings value the renderer
 * passed through (an imported `cardCutterEnginePath`, say) was enough to
 * run arbitrary code — and a UNC path (`\\host\share\x.js`) made Windows
 * open an SMB/WebDAV connection and send the user's NTLM hash on the way.
 *
 * Now main serves only:
 *   - files under a directory main itself owns (userData/plugins); or
 *   - a file the user picked in a main-side native dialog. Card-cutter
 *     picks are persisted (the engine path is a lasting setting); plugin
 *     "load from file" picks last for the session.
 * and in every case only a local, absolute `.js`/`.mjs`/`.cjs` path —
 * never a network path (`\\…` or `//…`), and on Windows only a path on a
 * drive letter.
 *
 * Comparisons are case-insensitive on Windows/macOS.
 */
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const CODE_EXT = /\.(?:js|mjs|cjs)$/i;
const JOURNAL_NAME = 'code-grants.json';
const JOURNAL_CAP = 20;

export interface CodePathRules {
  platform: NodeJS.Platform;
  /** Exact files that may be read. */
  files: Iterable<string>;
  /** Directories whose files (at any depth) may be read. */
  dirs: Iterable<string>;
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function fold(p: string, platform: NodeJS.Platform): string {
  const norm = pathFor(platform).normalize(p);
  return platform === 'win32' || platform === 'darwin' ? norm.toLowerCase() : norm;
}

/** Why `target` may not be read as code, or null when it may. Pure, so the
 *  rules are unit-testable on every platform. */
export function codePathRefusal(target: unknown, rules: CodePathRules): string | null {
  if (typeof target !== 'string' || !target.trim()) return 'no path';
  // Network paths, in either slash style (also covers \\?\ and \\.\).
  if (/^[\\/]{2}/.test(target)) return 'network paths are not allowed';
  const p = pathFor(rules.platform);
  if (rules.platform === 'win32') {
    if (!/^[a-zA-Z]:[\\/]/.test(target)) return 'only files on a local drive are allowed';
  } else if (!p.isAbsolute(target)) {
    return 'not an absolute path';
  }
  if (!CODE_EXT.test(target)) return 'not a .js file';
  const t = fold(target, rules.platform);
  for (const f of rules.files) {
    if (f && fold(f, rules.platform) === t) return null;
  }
  for (const d of rules.dirs) {
    if (!d) continue;
    const dir = fold(d, rules.platform);
    const prefix = dir.endsWith(p.sep) ? dir : dir + p.sep;
    if (t.startsWith(prefix)) return null;
  }
  return 'not a file you picked, or in the app\u2019s plugins folder';
}

// ── Grants (main-side only; never set from the renderer) ──

const sessionFiles = new Set<string>();
let persisted: string[] = [];
let journalLoaded: Promise<void> | null = null;

function journalPath(): string {
  return path.join(app.getPath('userData'), JOURNAL_NAME);
}

function loadJournalOnce(): Promise<void> {
  if (!journalLoaded) {
    journalLoaded = (async () => {
      try {
        const raw = JSON.parse(await fs.readFile(journalPath(), 'utf8')) as { paths?: unknown };
        if (Array.isArray(raw.paths)) {
          persisted = raw.paths.filter((x): x is string => typeof x === 'string').slice(-JOURNAL_CAP);
        }
      } catch {
        /* no journal yet */
      }
    })();
  }
  return journalLoaded;
}

/** A file the user picked in a main-side dialog. `persist` keeps it
 *  readable in later sessions (the card-cutter engine path setting). */
export async function grantCodeFile(p: string, opts: { persist?: boolean } = {}): Promise<void> {
  if (typeof p !== 'string' || !p) return;
  sessionFiles.add(p);
  if (!opts.persist) return;
  await loadJournalOnce();
  persisted = [...persisted.filter((x) => x !== p), p].slice(-JOURNAL_CAP);
  try {
    const finalPath = journalPath();
    const tmp = `${finalPath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, paths: persisted }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, finalPath);
  } catch {
    /* best-effort — the session grant still works */
  }
}

/** Read `target` as code if the rules allow it. `dirs` are main-owned
 *  directories; `extraFiles` are fixed files main chose (a default path). */
export async function readCodeFile(
  target: string,
  scope: { dirs?: string[]; extraFiles?: string[] },
): Promise<{ source: string } | { error: string }> {
  await loadJournalOnce();
  const refusal = codePathRefusal(target, {
    platform: process.platform,
    files: [...(scope.extraFiles ?? []), ...sessionFiles, ...persisted],
    dirs: scope.dirs ?? [],
  });
  if (refusal) return { error: `Refused to load ${target}: ${refusal}.` };
  try {
    return { source: await fs.readFile(target, 'utf8') };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
