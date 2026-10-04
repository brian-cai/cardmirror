/**
 * Ed25519 signatures on release artifacts — the check that decides whether a
 * downloaded update may install.
 *
 * electron-updater already checks each download's sha512 against the
 * release's `latest*.yml`, but that manifest comes from the same place as the
 * download: whoever can publish a release (a stolen token, a hijacked
 * account, a redirected update source) can publish a matching manifest too.
 * So every release artifact also gets a detached signature, `<name>.sig`,
 * made in CI with a private key that lives only in the repository's secrets.
 * The app carries the public keys it trusts (`update-keys.ts`) and installs an
 * update only when one of them verifies.
 *
 * The signed message binds the file's name and version to its hash, so a
 * signature can't be replayed onto another file or an older release:
 *
 *   cardmirror-update-v1\n<file name>\n<version>\n<sha512, base64>
 *
 * Pure module (no `electron` import) so it's unit-testable; the release
 * workflow signs with the same `signingMessage` (scripts/sign-release.cjs
 * mirrors it).
 */

import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const SIGNATURE_FORMAT = 'cardmirror-update-v1';

export interface TrustedUpdateKey {
  /** Human-readable label, e.g. "brian-cai 2026". */
  id: string;
  /** Ed25519 public key, SubjectPublicKeyInfo DER, base64. */
  spki: string;
}

/** The exact bytes that are signed for one artifact. */
export function signingMessage(fileName: string, version: string, sha512b64: string): Buffer {
  return Buffer.from(`${SIGNATURE_FORMAT}\n${fileName}\n${version}\n${sha512b64}`, 'utf8');
}

/** Streams `file` through sha512; base64, the same encoding electron-builder
 *  uses in `latest*.yml`. */
export function sha512File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')));
  });
}

/** The id of the first trusted key that verifies `signatureB64` over this
 *  artifact, or null when none does (or the signature is malformed). */
export function verifyArtifactSignature(opts: {
  fileName: string;
  version: string;
  sha512b64: string;
  signatureB64: string;
  trustedKeys: readonly TrustedUpdateKey[];
}): string | null {
  const sig = Buffer.from(opts.signatureB64.trim(), 'base64');
  if (sig.length !== 64) return null;
  const msg = signingMessage(opts.fileName, opts.version, opts.sha512b64);
  for (const k of opts.trustedKeys) {
    try {
      const key = createPublicKey({ key: Buffer.from(k.spki, 'base64'), format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') continue;
      if (verify(null, msg, key, sig)) return k.id;
    } catch {
      // A malformed key entry can't verify anything; try the next one.
    }
  }
  return null;
}

/** Which artifact of `files` (electron-updater's `UpdateInfo.files`) the
 *  downloaded bytes are: matched by sha512, so a renamed cache file still
 *  resolves to its published name. */
export function artifactNameFor(
  files: readonly { url: string; sha512?: string }[],
  sha512b64: string,
): string | null {
  const hit = files.find((f) => f.sha512 === sha512b64);
  if (!hit) return null;
  const last = hit.url.split(/[\\/]/).pop() ?? '';
  return last ? decodeURIComponent(last) : null;
}
