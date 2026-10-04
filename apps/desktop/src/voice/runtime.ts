/**
 * Speech-engine runtime: where the downloaded sherpa-onnx packages live
 * and how they are fetched and checked. Pure helpers (no Electron) so
 * the layout, naming, and integrity rules are unit-testable; ipc.ts
 * wires them to userData and the download UI.
 *
 * Why a download at all: most people never turn voice on, and the
 * native runtime is ~32 MB per platform (both mac slices ride in the
 * universal build), so it stays out of the installer like the 640 MB
 * model does. The two npm packages — `sherpa-onnx-node` (JS glue) and
 * the per-platform `sherpa-onnx-<os>-<arch>` (the N-API addon plus
 * onnxruntime) — are laid out under a node_modules directory so the
 * worker's `require('sherpa-onnx-node')` resolves through NODE_PATH and
 * the addon's own sibling-package lookup works unchanged.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Pinned engine version. The devDependency copy must match, so dev and
 *  packaged builds run the same binaries. */
export const SHERPA_VERSION = '1.13.7';
/** Approximate compressed size of both packages, for the prompt. */
export const ENGINE_DOWNLOAD_MB = 10;
export const NPM_REGISTRY = 'https://registry.npmjs.org';

/** Upstream publishes the Windows package as `sherpa-onnx-win-x64`
 *  (the `win32` name tripped npm's spam filter). */
export function platformPackageName(platform: string = process.platform, arch: string = process.arch): string {
  return `sherpa-onnx-${platform === 'win32' ? 'win' : platform}-${arch}`;
}

/** Both packages a host needs, glue first. */
export function enginePackages(platform?: string, arch?: string): string[] {
  return ['sherpa-onnx-node', platformPackageName(platform, arch)];
}

export function packumentUrl(name: string, version: string = SHERPA_VERSION): string {
  return `${NPM_REGISTRY}/${name}/${version}`;
}

export interface PackumentDist {
  tarball: string;
  integrity: string;
}

/** The registry's per-version document carries the tarball URL and an
 *  SRI string; refuse anything that is not an https tarball with a
 *  sha512 entry so a tampered or truncated document cannot downgrade
 *  the check. */
export function parsePackument(json: unknown): PackumentDist {
  const dist = (json as { dist?: { tarball?: unknown; integrity?: unknown } } | null)?.dist;
  const tarball = typeof dist?.tarball === 'string' ? dist.tarball : '';
  const integrity = typeof dist?.integrity === 'string' ? dist.integrity : '';
  if (!tarball.startsWith('https://')) throw new Error('engine packument: no https tarball');
  const sha512 = integrity.split(/\s+/).find((s) => s.startsWith('sha512-'));
  if (!sha512) throw new Error('engine packument: no sha512 integrity');
  return { tarball, integrity: sha512 };
}

/** Present = the glue package plus this host's native addon, both where
 *  NODE_PATH will look. */
export function enginePresentAt(nodeModules: string, platform?: string, arch?: string): boolean {
  return (
    fs.existsSync(path.join(nodeModules, 'sherpa-onnx-node', 'package.json')) &&
    fs.existsSync(path.join(nodeModules, platformPackageName(platform, arch), 'sherpa-onnx.node'))
  );
}

/** Pinned sha512 (SRI) of each engine package at SHERPA_VERSION. The
 *  download must match THIS, not just the registry's own document, so a
 *  compromised registry response or a republished package can't slip a
 *  different native addon in. Bump together with SHERPA_VERSION
 *  (`npm view <pkg>@<version> dist.integrity`). */
export const PINNED_ENGINE_INTEGRITY: Readonly<Record<string, string>> = {
  'sherpa-onnx-node': 'sha512-0XGV7arGngBCnol0m8OLyqlnaUm19Q1KmetVj1DDBdymXa1upmAHZDwNdN47gjsEhqE5hXUEyc1vRQoXrNhNVg==',
  'sherpa-onnx-darwin-arm64': 'sha512-5NCE50hAvr3n2pdett0SgfPBJXaFZE0bqHwbHyiq+IKZ8Ids0l4M0VrG+ImGYIafCwie+oC3uAJ+pKj9xg/k+w==',
  'sherpa-onnx-darwin-x64': 'sha512-N3o+T+wn9WaQmsKV5DD8bTHdo+WN2+sXwmZcGJZiDjtOMR2zFz7uVCZnYCmEAMgvChC+oHcF5RvEEKcRCAu6Pw==',
  'sherpa-onnx-win-x64': 'sha512-wBV1o+/zgsMrOjfCFIgGrH6S28xq6CqRCLSavCOjTZ6cqr80yGc07DUHxqsHFPZvfoJU+2JF5L2l3gyWFWoWdQ==',
  'sherpa-onnx-win-ia32': 'sha512-sTwtpxPQ76XLn0giAbvknIDEDKD3XXi2mo2AVROEucf1pIK1DjQl+LjLkalTeFoQqbC4J3xGx/g+xgcHQD1dsw==',
  'sherpa-onnx-linux-x64': 'sha512-npmxn5WwmAmlthgBhmbZ33t3i2j4mJwQt46dMEb3j7d41y1/uJrjrVAfa/DkvV+vn49ZWfcQ2UEWDipaZBVhuw==',
  'sherpa-onnx-linux-arm64': 'sha512-TFCVpXyTh69buhOtTS8KIfkRXOVKY4Y1qjAktSItrKS4A0chnnrlXO5bKWoNAPeI6fMxTF/uvMYbYgcvjEMfNg==',
};

/** The integrity an engine package must have: the pinned value; the
 *  registry's document must agree with it. Throws when the package has no
 *  pin or the registry disagrees. */
export function expectedEngineIntegrity(name: string, registryIntegrity: string): string {
  const pinned = PINNED_ENGINE_INTEGRITY[name];
  if (!pinned) throw new Error(`engine package ${name} has no pinned integrity`);
  if (registryIntegrity !== pinned) throw new Error(`engine package ${name}: registry integrity does not match the pinned value`);
  return pinned;
}

/** Pinned sha256 (hex) of the voice model downloads, from GitHub's asset
 *  digests for the sherpa-onnx `asr-models` release. */
export const PINNED_MODEL_SHA256: Readonly<Record<string, string>> = {
  'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2': '157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad',
  'silero_vad.onnx': '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
};

/** Streams `file` through sha256 and requires the pinned digest for its
 *  name; deletes the file on a mismatch so it's never used. */
export async function verifyPinnedSha256(file: string, name: string): Promise<void> {
  const expected = PINNED_MODEL_SHA256[name];
  if (!expected) throw new Error(`no pinned checksum for ${name}`);
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  if (hash.digest('hex') !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error(`voice download failed its checksum (${name})`);
  }
}

/** Streams `file` through sha512 and compares with the SRI value. */
export async function verifyIntegrity(file: string, integrity: string): Promise<void> {
  const expected = integrity.replace(/^sha512-/, '');
  const hash = crypto.createHash('sha512');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject);
  });
  const actual = hash.digest('base64');
  if (actual !== expected) throw new Error(`engine download failed its integrity check (${path.basename(file)})`);
}
