import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { createPairingKeystore, mailboxProofMac } from '../../apps/desktop/src/pairing-crypto.js';
import { createMailboxProofs, MAILBOX_PROOF_HEADER } from '../../apps/desktop/src/mailbox-proof.js';

const b = (s: string) => Buffer.from(s, 'base64url');

describe('mailbox proof v1', () => {
  it('matches the relay test vector (xtgg-relay TestMailboxProofVector)', () => {
    const client = createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', d: '4PmucOgffIuKNKrxqPOCtBR80WUYBYjqkRD-jX08AEI', x: '8pB2ioOXJb-pIuFgTYKVUgJWuPclbI5k3i5x1m32324' },
      format: 'jwk',
    });
    const relayPub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: 'gvLzV2acc2QI1Qol0Ak4Sw6YFE7ZKIdZxJtjRYuX7mE' }, format: 'jwk' });
    const shared = diffieHellman({ privateKey: client, publicKey: relayPub });
    const mac = mailboxProofMac(shared, b('8pB2ioOXJb-pIuFgTYKVUgJWuPclbI5k3i5x1m32324'), b('gvLzV2acc2QI1Qol0Ak4Sw6YFE7ZKIdZxJtjRYuX7mE'),
      'DELETE', 'BAv-el6lu4RdVysJCWlDag', 1761234567);
    expect(mac.toString('base64url')).toBe('9PA1eEJGKacTL7oiLp7nq3EREDFek8Wv-1nYeffSSeM');
  });

  it("the keystore's header verifies against the relay's key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mproof-'));
    const ks = createPairingKeystore(path.join(dir, 'keys.json'));
    const relay = generateKeyPairSync('x25519');
    const relayX = (relay.publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const [v, pub, ts, mac] = ks.mailboxProof(relayX, 'PUT', 1700000000).split('.');
    expect(v).toBe('v1');
    expect('cmk1.' + pub).toBe(ks.ownPublicCode());
    const routing = createHash('sha256').update(b(pub)).digest().subarray(0, 16).toString('base64url');
    expect(routing).toBe(ks.ownRoutingId());
    const clientPub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub }, format: 'jwk' });
    const shared = diffieHellman({ privateKey: relay.privateKey, publicKey: clientPub });
    expect(mailboxProofMac(shared, b(pub), b(relayX), 'PUT', routing, Number(ts)).toString('base64url')).toBe(mac);
  });

  it('only relays that advertise it get proofs, with their clock offset', async () => {
    const calls: string[] = [];
    let t = 1_700_000_000_000;
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://xtgg')) {
        return new Response(JSON.stringify({ v: 1, relayKey: 'A'.repeat(43), now: t / 1000 + 30 }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const signed: Array<[string, number]> = [];
    const p = createMailboxProofs({
      signer: () => ({ mailboxProof: (_k, m, ts) => (signed.push([m, ts]), `v1.x.${ts}.y`) }),
      fetchImpl,
      now: () => t,
    });
    expect(await p.ensure('https://other', {})).toBeNull();
    expect(p.headerFor('https://other', 'GET')).toEqual({});
    expect(await p.ensure('https://xtgg', {})).not.toBeNull();
    expect(p.headerFor('https://xtgg', 'DELETE')).toEqual({ [MAILBOX_PROOF_HEADER]: `v1.x.${t / 1000 + 30}.y` });
    // Cached: no second discovery within the freshness window, either way.
    await p.ensure('https://xtgg', {});
    await p.ensure('https://other', {});
    expect(calls.length).toBe(2);
    // Unsupported is asked again after an hour.
    t += 61 * 60 * 1000;
    await p.ensure('https://other', {});
    expect(calls.length).toBe(3);
    // A refusal forgets, so the next call re-discovers.
    p.forget('https://xtgg');
    expect(p.headerFor('https://xtgg', 'GET')).toEqual({});
  });
});
