// @vitest-environment jsdom
/**
 * 1.15.46 review: the web edition's failed send shows the relay-down bar
 * (notifyRelaySendFailed) as desktop does — not for a credential decline —
 * and on a custom relay a partial decline keeps its recipient count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const web = vi.hoisted(() => ({ send: vi.fn() }));
const failed = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return { ...mod, getElectronHost: () => null };
});
vi.mock('../../src/editor/collab/collab-gate.js', () => ({ collabEnabled: () => true }));
vi.mock('../../src/editor/pairing/web-mailbox.js', () => ({ webPairingSend: web.send }));
vi.mock('../../src/editor/collab/collab-hooks.js', () => ({ notifyRelaySendFailed: () => failed.n++ }));

import { relayClient, sendOutcomeToast } from '../../src/editor/pairing/relay-client.js';
import { settings } from '../../src/editor/settings.js';

const ITEM = { label: 'card', type: 'card', sliceJson: {} };

beforeEach(() => {
  failed.n = 0;
  web.send.mockReset();
  settings.set('pairingRelayUrl', '');
});

describe('web send → relay-down bar', () => {
  it('nothing delivered, not a decline → notified', async () => {
    web.send.mockResolvedValue({ ok: 0, fail: 2, authFail: 0 });
    expect(await relayClient.send(['a', 'b'], ITEM)).toEqual({ ok: 0, fail: 2, authFail: 0 });
    expect(failed.n).toBe(1);
  });

  it('a thrown send → notified', async () => {
    web.send.mockRejectedValue(new TypeError('offline'));
    expect(await relayClient.send(['a'], ITEM)).toEqual({ ok: 0, fail: 1, authFail: 0 });
    expect(failed.n).toBe(1);
  });

  it('a decline or a delivery → not notified', async () => {
    web.send.mockResolvedValue({ ok: 0, fail: 1, authFail: 1 });
    await relayClient.send(['a'], ITEM);
    web.send.mockResolvedValue({ ok: 1, fail: 1, authFail: 0 });
    await relayClient.send(['a', 'b'], ITEM);
    expect(failed.n).toBe(0);
  });
});

describe('a partial decline on a custom relay', () => {
  it('keeps "for N recipient(s)"; a total decline keeps the custom sentence', () => {
    settings.set('pairingRelayUrl', 'https://team.example/relay');
    const partial = sendOutcomeToast('team', { ok: 3, fail: 1, authFail: 1 });
    expect(partial).toMatch(/^The relay declined your credentials for 1 recipient\(s\)\./);
    expect(partial).not.toMatch(/didn’t accept this computer|Debate Decoded/);
    expect(sendOutcomeToast('Aki', { ok: 0, fail: 1, authFail: 1 })).toMatch(/didn’t accept this computer/);
  });
});
