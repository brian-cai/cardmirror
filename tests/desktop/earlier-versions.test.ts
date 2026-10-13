// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  earlierVersionsFrom,
  manifestNameFor,
  releaseFeedUrl,
} from '../../apps/desktop/src/earlier-versions.js';

const rel = (tag: string, assets: string[], extra: Record<string, unknown> = {}): unknown => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T00:00:00Z',
  assets: assets.map((name) => ({ name })),
  ...extra,
});
const mac = (v: string): string[] => [
  'latest-mac.yml',
  `CardMirror-${v}-universal-mac.zip`,
  `CardMirror-${v}-universal-mac.zip.sig`,
];

describe('compareVersions', () => {
  it('orders by number, not text', () => {
    expect(compareVersions('1.14.13', '1.15.1')).toBeLessThan(0);
    expect(compareVersions('1.14.13', '1.14.9')).toBeGreaterThan(0);
    expect(compareVersions('1.15.4', '1.15.4')).toBe(0);
  });
  it('rejects anything but x.y.z', () => {
    expect(compareVersions('1.15.4-beta.1', '1.15.4')).toBeNull();
    expect(compareVersions('latest', '1.15.4')).toBeNull();
  });
});

describe('earlierVersionsFrom', () => {
  const opts = { current: '1.15.4', manifest: 'latest-mac.yml', requireSignature: true };

  it('lists older signed releases for this platform, newest first', () => {
    const list = earlierVersionsFrom(
      [rel('v1.14.13', mac('1.14.13')), rel('v1.15.3', mac('1.15.3')), rel('v1.15.1', mac('1.15.1'))],
      opts,
    );
    expect(list.map((v) => v.version)).toEqual(['1.15.3', '1.15.1', '1.14.13']);
  });

  it('leaves out the running version, newer ones, drafts and pre-releases', () => {
    const list = earlierVersionsFrom(
      [
        rel('v1.15.4', mac('1.15.4')),
        rel('v1.16.0', mac('1.16.0')),
        rel('v1.15.3', mac('1.15.3'), { draft: true }),
        rel('v1.15.2', mac('1.15.2'), { prerelease: true }),
        rel('v1.15.1-beta.1', mac('1.15.1-beta.1')),
        rel('v1.15.0', mac('1.15.0')),
      ],
      opts,
    );
    expect(list.map((v) => v.version)).toEqual(['1.15.0']);
  });

  it('leaves out releases with no signature or no build for this platform', () => {
    const unsigned = ['latest-mac.yml', 'CardMirror-1.14.1-universal-mac.zip'];
    const windowsOnly = ['latest.yml', 'CardMirror-Setup-1.14.5.exe', 'CardMirror-Setup-1.14.5.exe.sig'];
    const releases = [rel('v1.14.1', unsigned), rel('v1.14.5', windowsOnly)];
    expect(earlierVersionsFrom(releases, opts)).toEqual([]);
    // An unsigned stream has nothing to require.
    expect(
      earlierVersionsFrom(releases, { ...opts, requireSignature: false }).map((v) => v.version),
    ).toEqual(['1.14.1']);
  });

  it('survives a body that is not a release list', () => {
    expect(earlierVersionsFrom({ message: 'rate limited' }, opts)).toEqual([]);
    expect(earlierVersionsFrom([null, 3, {}], opts)).toEqual([]);
  });
});

describe('manifestNameFor / releaseFeedUrl', () => {
  it('names the manifest electron-updater reads on each platform', () => {
    expect(manifestNameFor('darwin', 'arm64')).toBe('latest-mac.yml');
    expect(manifestNameFor('win32', 'x64')).toBe('latest.yml');
    expect(manifestNameFor('linux', 'x64')).toBe('latest-linux.yml');
    expect(manifestNameFor('linux', 'arm64')).toBe('latest-linux-arm64.yml');
    expect(manifestNameFor('freebsd', 'x64')).toBeNull();
  });
  it('points at one release', () => {
    expect(releaseFeedUrl({ owner: 'brian-cai', repo: 'cardmirror' }, '1.15.3')).toBe(
      'https://github.com/brian-cai/cardmirror/releases/download/v1.15.3',
    );
  });
});
