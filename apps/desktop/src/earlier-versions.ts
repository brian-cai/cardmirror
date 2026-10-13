/**
 * Going back to an earlier release (Settings → General → "Earlier
 * versions"): which of a stream's past releases this install can switch to,
 * and where electron-updater finds one of them.
 *
 * A past release is installed the same way as a new one: electron-updater
 * downloads it from that release's own manifest, the download must carry a
 * valid signature (update-signature.ts), and the usual installer / bundle
 * swap puts it in place. The only differences are that the feed points at
 * one release instead of "latest" and that a lower version is accepted.
 *
 * Pure module (no `electron` import) so it's unit-testable.
 */

import type { UpdateSource } from './update-source.js';

export interface EarlierVersion {
  version: string;
  /** ISO date the release was published, or '' when GitHub gave none. */
  publishedAt: string;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Plain `x.y.z` only: pre-releases are never offered. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = VERSION_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when `a` is older than `b`; null when either isn't `x.y.z`. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

/** The manifest electron-updater reads for this platform; a release
 *  without it has nothing this install can update to. */
export function manifestNameFor(platform: string, arch: string): string | null {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'win32') return 'latest.yml';
  if (platform === 'linux') return arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
  return null;
}

/** The releases (GitHub's `GET /repos/:o/:r/releases` body) this install
 *  can go back to, newest first: published, not a pre-release, older than
 *  `current`, built for this platform, and — on a signed stream — signed. */
export function earlierVersionsFrom(
  releases: unknown,
  opts: { current: string; manifest: string; requireSignature: boolean; limit?: number },
): EarlierVersion[] {
  if (!Array.isArray(releases)) return [];
  const out: EarlierVersion[] = [];
  for (const raw of releases as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as {
      tag_name?: unknown;
      draft?: unknown;
      prerelease?: unknown;
      published_at?: unknown;
      assets?: unknown;
    };
    if (r.draft || r.prerelease || typeof r.tag_name !== 'string') continue;
    const version = r.tag_name.replace(/^v/, '');
    const cmp = compareVersions(version, opts.current);
    if (cmp === null || cmp >= 0) continue;
    const names = Array.isArray(r.assets)
      ? (r.assets as { name?: unknown }[]).map((a) => (typeof a?.name === 'string' ? a.name : ''))
      : [];
    if (!names.includes(opts.manifest)) continue;
    if (opts.requireSignature && !names.some((n) => n.endsWith('.sig'))) continue;
    if (out.some((v) => v.version === version)) continue;
    out.push({ version, publishedAt: typeof r.published_at === 'string' ? r.published_at : '' });
  }
  out.sort((a, b) => compareVersions(b.version, a.version) ?? 0);
  return out.slice(0, opts.limit ?? 15);
}

/** Where one release's manifest and files live: electron-updater's
 *  `generic` provider reads `<url>/latest*.yml` and resolves the file
 *  names in it against the same folder. */
export function releaseFeedUrl(src: UpdateSource, version: string): string {
  return `https://github.com/${src.owner}/${src.repo}/releases/download/v${version}`;
}
