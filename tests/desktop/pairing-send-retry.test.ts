/**
 * Card / session-invite delivery on bad wifi: a send retries transient
 * failures, and a retry whose earlier attempt landed after all (both
 * copies on the relay) shows up in the receiver's inbox once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pairing-'));

vi.mock('electron', () => ({
  app: { getPath: () => userData, getVersion: () => '9.9.9' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn), on: () => {} },
  net: { isOnline: () => true },
  powerMonitor: { on: () => {} },
}));

const call = (ch: string, arg?: unknown) => handlers.get(ch)!({}, arg);
const RELAY = 'http://relay.test';

describe('pairing send on a flaky network', () => {
  const posted: Record<string, unknown>[] = [];
  let postFailures = 0;
  let streamFrames: string[] = [];

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST' && url === `${RELAY}/messages`) {
        if (postFailures > 0) {
          postFailures--;
          throw new TypeError('fetch failed');
        }
        posted.push(JSON.parse(gunzipSync(init.body as Buffer).toString('utf8')));
        return new Response('{"ok":true}', { status: 201 });
      }
      if (url.startsWith(`${RELAY}/stream`)) {
        const body = ['event: hello\ndata: {}\n\n', ...streamFrames].join('');
        return new Response(new Blob([body]).stream(), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      if (url.startsWith(`${RELAY}/messages?`)) return new Response(null, { status: 304 });
      return new Response(null, { status: 204 }); // DELETE acks etc.
    });
    const mod = await import('../../apps/desktop/src/pairing-ipc.js');
    mod.registerPairingIpc();
  });

  afterAll(async () => {
    await call('host:pairing-configure', { enabled: false });
    vi.unstubAllGlobals();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('retries through network errors, and a doubled delivery lands once', async () => {
    // Turn sharing on long enough to mint our key, then park delivery.
    const { ownCode } = (await call('host:pairing-configure', {
      enabled: true,
      relayUrl: 'http://other.test',
      displayName: 'Me',
    })) as { ownCode: string };
    await call('host:pairing-configure', { enabled: false, relayUrl: RELAY, displayName: 'Me' });

    postFailures = 2;
    const res = (await call('host:pairing-send', {
      recipientCodes: [ownCode],
      item: { label: 'Invite', type: 'session-invite', sliceJson: { room: 'r1' } },
    })) as { ok: number; fail: number };
    expect(res).toEqual({ ok: 1, fail: 0, authFail: 0 });
    expect(posted).toHaveLength(1);

    // The relay ended up holding the bundle twice (a lost response made
    // the client resend): two msgIds, same sealed payload.
    streamFrames = ['m-a', 'm-b'].map((msgId) => `data: ${JSON.stringify({ ...posted[0], msgId })}\n\n`);
    await call('host:pairing-configure', { enabled: true, relayUrl: RELAY, displayName: 'Me' });
    await vi.waitFor(async () => {
      const inbox = (await call('host:pairing-inbox-list')) as unknown[];
      expect(inbox).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect((await call('host:pairing-inbox-list')) as unknown[]).toHaveLength(1);
  }, 20_000);

  it('gives up after its retries and reports the failure', async () => {
    await call('host:pairing-configure', { enabled: false, relayUrl: RELAY, displayName: 'Me' });
    postFailures = 99;
    const res = (await call('host:pairing-send', {
      recipientCodes: ['x'.repeat(10)],
      item: { label: 'Card', type: 'card', sliceJson: {} },
    })) as { ok: number; fail: number };
    postFailures = 0;
    expect(res.ok).toBe(0);
    expect(res.fail).toBe(1);
  }, 30_000);
});
