// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  artifactNameFor,
  sha512File,
  verifyArtifactSignature,
  type TrustedUpdateKey,
} from '../../apps/desktop/src/update-signature.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cardmirror-sig-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function keypair(): { pem: string; trusted: TrustedUpdateKey } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    trusted: { id: 'test', spki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') },
  };
}

/** Sign the way CI does: run the real release script over a temp dir. */
function signWithScript(pem: string, version: string): void {
  execFileSync(process.execPath, [path.join(__dirname, '../../apps/desktop/scripts/sign-release.cjs'), version], {
    env: { ...process.env, UPDATE_SIGNING_KEY: pem, RELEASE_DIR: dir },
  });
}

describe('update signatures', () => {
  it('a release signed by CI verifies against the trusted key', async () => {
    const { pem, trusted } = keypair();
    const name = 'CardMirror-Setup-1.14.2.exe';
    writeFileSync(path.join(dir, name), 'installer bytes');
    signWithScript(pem, '1.14.2');
    const sha = await sha512File(path.join(dir, name));
    const sig = readFileSync(path.join(dir, `${name}.sig`), 'utf8');
    expect(
      verifyArtifactSignature({ fileName: name, version: '1.14.2', sha512b64: sha, signatureB64: sig, trustedKeys: [trusted] }),
    ).toBe('test');
  });

  it('refuses tampered bytes, another key, another file name, or another version', async () => {
    const { pem, trusted } = keypair();
    const other = keypair().trusted;
    const name = 'CardMirror-1.14.2-universal-mac.zip';
    writeFileSync(path.join(dir, name), 'zip bytes');
    signWithScript(pem, '1.14.2');
    const sig = readFileSync(path.join(dir, `${name}.sig`), 'utf8');
    const sha = await sha512File(path.join(dir, name));
    writeFileSync(path.join(dir, name), 'evil bytes');
    const evil = await sha512File(path.join(dir, name));
    const v = (o: Partial<Parameters<typeof verifyArtifactSignature>[0]>) =>
      verifyArtifactSignature({ fileName: name, version: '1.14.2', sha512b64: sha, signatureB64: sig, trustedKeys: [trusted], ...o });
    expect(v({ sha512b64: evil })).toBeNull();
    expect(v({ trustedKeys: [other] })).toBeNull();
    expect(v({ trustedKeys: [] })).toBeNull();
    expect(v({ fileName: 'CardMirror-Setup-1.14.2.exe' })).toBeNull();
    expect(v({ version: '1.14.1' })).toBeNull();
    expect(v({ signatureB64: 'not a signature' })).toBeNull();
    expect(v({ trustedKeys: [{ id: 'junk', spki: 'AAAA' }, trusted] })).toBe('test');
  });

  it('the release script refuses to run without the key', () => {
    writeFileSync(path.join(dir, 'CardMirror-Setup-1.14.2.exe'), 'x');
    expect(() =>
      execFileSync(process.execPath, [path.join(__dirname, '../../apps/desktop/scripts/sign-release.cjs'), '1.14.2'], {
        env: { ...process.env, UPDATE_SIGNING_KEY: '', RELEASE_DIR: dir },
        stdio: 'ignore',
      }),
    ).toThrow();
  });

  it('maps downloaded bytes to their published artifact name by hash', () => {
    const files = [
      { url: 'CardMirror-1.14.2-universal-mac.zip', sha512: 'aaa' },
      { url: 'https://example.com/x/CardMirror-1.14.2-universal.dmg', sha512: 'bbb' },
    ];
    expect(artifactNameFor(files, 'bbb')).toBe('CardMirror-1.14.2-universal.dmg');
    expect(artifactNameFor(files, 'ccc')).toBeNull();
  });
});
