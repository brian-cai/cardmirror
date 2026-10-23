/**
 * Collaboration is on by default, so "ready to share" also needs a relay
 * this computer can use: a fresh install with no relay, account or team
 * file gets the setup offer (sharing-setup.ts), not a send that fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = { usable: false as boolean | undefined };

vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      collabRelayDefaults: async () => ({ url: 'https://builtin.example', token: '', routingCode: '', usable: host.usable }),
    }),
  };
});

import { sharingReady } from '../../src/editor/pairing/sharing-setup.js';
import { ensureBakedRelay, refreshBakedRelay } from '../../src/editor/collab/collab-relay.js';
import { settings } from '../../src/editor/settings.js';

beforeEach(async () => {
  settings.set('pairingEnabled', true);
  settings.set('pairingRelayUrl', '');
  host.usable = false;
  await ensureBakedRelay();
  await refreshBakedRelay();
});

describe('sharingReady', () => {
  it('collaboration on but no usable relay → not ready (setup is offered)', () => {
    expect(sharingReady()).toBe(false);
  });

  it('a relay set in Settings is ready', () => {
    settings.set('pairingRelayUrl', 'https://relay.example/r/team');
    expect(sharingReady()).toBe(true);
  });

  it('the built-in relay usable (an account, a baked token) is ready', async () => {
    host.usable = true;
    await refreshBakedRelay();
    expect(sharingReady()).toBe(true);
  });

  it('an older main that does not say counts as ready', async () => {
    host.usable = undefined;
    await refreshBakedRelay();
    expect(sharingReady()).toBe(true);
  });

  it('collaboration off is never ready', async () => {
    host.usable = true;
    await refreshBakedRelay();
    settings.set('pairingEnabled', false);
    expect(sharingReady()).toBe(false);
  });
});
