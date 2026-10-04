/**
 * The speech engine is a first-use download (like the model): these pin
 * the package naming, the registry-document checks, the on-disk
 * presence rule the worker's NODE_PATH relies on, and the sha512 gate.
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SHERPA_VERSION,
  enginePackages,
  enginePresentAt,
  packumentUrl,
  parsePackument,
  platformPackageName,
  verifyIntegrity,
} from '../../apps/desktop/src/voice/runtime';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-voice-runtime-'));
}

describe('voice engine runtime helpers', () => {
  it('names the platform package the way upstream publishes it', () => {
    expect(platformPackageName('darwin', 'arm64')).toBe('sherpa-onnx-darwin-arm64');
    expect(platformPackageName('darwin', 'x64')).toBe('sherpa-onnx-darwin-x64');
    expect(platformPackageName('linux', 'x64')).toBe('sherpa-onnx-linux-x64');
    expect(platformPackageName('win32', 'x64'), 'win32 is published as win').toBe('sherpa-onnx-win-x64');
    expect(enginePackages('win32', 'x64')).toEqual(['sherpa-onnx-node', 'sherpa-onnx-win-x64']);
    expect(packumentUrl('sherpa-onnx-node')).toBe(`https://registry.npmjs.org/sherpa-onnx-node/${SHERPA_VERSION}`);
  });

  it('the devDependency pin matches the download pin', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'apps/desktop/package.json'), 'utf8'));
    expect(pkg.devDependencies['sherpa-onnx-node']).toBe(SHERPA_VERSION);
    expect(pkg.dependencies?.['sherpa-onnx-node'], 'the engine must not ship in the installer').toBeUndefined();
    expect(JSON.stringify(pkg.build.asarUnpack)).not.toContain('sherpa');
  });

  it('accepts only an https tarball with a sha512 entry', () => {
    expect(parsePackument({ dist: { tarball: 'https://r/x.tgz', integrity: 'sha1-abc sha512-def' } })).toEqual({
      tarball: 'https://r/x.tgz',
      integrity: 'sha512-def',
    });
    expect(() => parsePackument({ dist: { tarball: 'http://r/x.tgz', integrity: 'sha512-def' } })).toThrow(/https/);
    expect(() => parsePackument({ dist: { tarball: 'https://r/x.tgz', integrity: 'sha1-abc' } })).toThrow(/sha512/);
    expect(() => parsePackument(null)).toThrow();
  });

  it('present means glue package.json plus this host\'s addon, both under node_modules', () => {
    const nm = tmp();
    expect(enginePresentAt(nm, 'linux', 'x64')).toBe(false);
    fs.mkdirSync(path.join(nm, 'sherpa-onnx-node'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'sherpa-onnx-node', 'package.json'), '{}');
    expect(enginePresentAt(nm, 'linux', 'x64'), 'glue alone is not enough').toBe(false);
    fs.mkdirSync(path.join(nm, 'sherpa-onnx-linux-x64'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'sherpa-onnx-linux-x64', 'sherpa-onnx.node'), 'x');
    expect(enginePresentAt(nm, 'linux', 'x64')).toBe(true);
    expect(enginePresentAt(nm, 'win32', 'x64'), 'another host\'s addon does not count').toBe(false);
  });

  it('verifyIntegrity passes on the right sha512 and rejects a tampered file', async () => {
    const dir = tmp();
    const file = path.join(dir, 'pkg.tgz');
    fs.writeFileSync(file, 'engine bytes');
    const good = 'sha512-' + crypto.createHash('sha512').update('engine bytes').digest('base64');
    await expect(verifyIntegrity(file, good)).resolves.toBeUndefined();
    fs.appendFileSync(file, '!');
    await expect(verifyIntegrity(file, good)).rejects.toThrow(/integrity/);
  });
});

describe('pinned voice download checksums', () => {
  it('every engine package for every platform has a pinned integrity', async () => {
    const { PINNED_ENGINE_INTEGRITY, enginePackages } = await import('../../apps/desktop/src/voice/runtime.js');
    for (const [platform, arch] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']] as const) {
      for (const name of enginePackages(platform, arch)) {
        expect(PINNED_ENGINE_INTEGRITY[name], name).toMatch(/^sha512-/);
      }
    }
  });

  it('refuses a registry integrity that differs from the pin', async () => {
    const { expectedEngineIntegrity, PINNED_ENGINE_INTEGRITY } = await import('../../apps/desktop/src/voice/runtime.js');
    const pin = PINNED_ENGINE_INTEGRITY['sherpa-onnx-node']!;
    expect(expectedEngineIntegrity('sherpa-onnx-node', pin)).toBe(pin);
    expect(() => expectedEngineIntegrity('sherpa-onnx-node', 'sha512-AAAA')).toThrow();
    expect(() => expectedEngineIntegrity('evil-package', pin)).toThrow();
  });

  it('deletes a model download whose checksum is wrong', async () => {
    const { verifyPinnedSha256 } = await import('../../apps/desktop/src/voice/runtime.js');
    const fsm = await import('node:fs');
    const osm = await import('node:os');
    const pathm = await import('node:path');
    const f = pathm.join(fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'cm-vad-')), 'silero_vad.onnx');
    fsm.writeFileSync(f, 'not the model');
    await expect(verifyPinnedSha256(f, 'silero_vad.onnx')).rejects.toThrow(/checksum/);
    expect(fsm.existsSync(f)).toBe(false);
  });
});
