import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import {
  createPairingKeystore,
  mailboxProofBodyHash,
  mailboxProofMac,
  mailboxProofMacV2,
  mailboxProofOrigin,
} from '../../apps/desktop/src/pairing-crypto.js';
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
    const [v, pub, ts, mac] = ks.mailboxProof(relayX, 'PUT', 1700000000).split('.') as [string, string, string, string];
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

describe('mailbox proof v2', () => {
  // The relay's vector (xtgg-relay docs/mailbox-proof-v2.md,
  // TestMailboxProofV2Vector): same keys as the v1 vector.
  const CLIENT_D = '4PmucOgffIuKNKrxqPOCtBR80WUYBYjqkRD-jX08AEI';
  const CLIENT_X = '8pB2ioOXJb-pIuFgTYKVUgJWuPclbI5k3i5x1m32324';
  const RELAY_X = 'gvLzV2acc2QI1Qol0Ak4Sw6YFE7ZKIdZxJtjRYuX7mE';
  const RCP = 'BAv-el6lu4RdVysJCWlDag';
  const ORIGIN = 'https://relay.extinction.gg';
  const BODY = `{"code":"cmk1.${CLIENT_X}","name":"Sam"}`;
  const shared = () =>
    diffieHellman({
      privateKey: createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: CLIENT_D, x: CLIENT_X }, format: 'jwk' }),
      publicKey: createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: RELAY_X }, format: 'jwk' }),
    });

  it('matches the relay test vector (xtgg-relay TestMailboxProofV2Vector)', () => {
    expect(shared().toString('base64url')).toBe('Bn9s5ZOEqmu6zJQg5MJq0mOT-QTBokcgLM-UBRcWiDI');
    expect(mailboxProofOrigin('https://relay.extinction.gg/r/abc123')).toBe(ORIGIN);
    const del = mailboxProofMacV2(shared(), b(CLIENT_X), b(RELAY_X), ORIGIN, 'DELETE', RCP, 1761234567, mailboxProofBodyHash('DELETE'));
    expect(del.toString('base64url')).toBe('4D2C9-ueOHnJ82YG6jQ0RyvHzPlRibE7vPtTGB6x-yY');
    const bh = mailboxProofBodyHash('PUT', BODY);
    expect(bh).toBe('XMIzxzTC3lYGCSqkI_QNJzO1PTg6yvNCBbX9A0bc0Cw');
    const put = mailboxProofMacV2(shared(), b(CLIENT_X), b(RELAY_X), ORIGIN, 'PUT', RCP, 1761234567, bh);
    expect(put.toString('base64url')).toBe('9AVB8YK_wox895mImwin02bqi9P8NkAHx4DLMotqzTA');
  });

  it('BODYHASH is only for PUT, over the exact bytes', () => {
    expect(mailboxProofBodyHash('GET')).toBe('');
    expect(mailboxProofBodyHash('DELETE', 'x')).toBe('');
    expect(mailboxProofBodyHash('PUT', BODY)).toBe(mailboxProofBodyHash('PUT', new TextEncoder().encode(BODY)));
    expect(mailboxProofBodyHash('PUT', BODY + ' ')).not.toBe(mailboxProofBodyHash('PUT', BODY));
    expect(mailboxProofBodyHash('PUT')).toBe(createHash('sha256').update('').digest('base64url'));
  });

  it('ORIGIN is the lowercase scheme://host[:port] of the configured URL, default port left out', () => {
    expect(mailboxProofOrigin('https://Relay.Example.COM/relay')).toBe('https://relay.example.com');
    expect(mailboxProofOrigin('https://relay.example.com:443/relay')).toBe('https://relay.example.com');
    expect(mailboxProofOrigin('HTTP://relay.example.com:80')).toBe('http://relay.example.com');
    expect(mailboxProofOrigin('https://relay.example.com:8443/x/y?z')).toBe('https://relay.example.com:8443');
    expect(mailboxProofOrigin('http://[::1]:8080/relay')).toBe('http://[::1]:8080');
    expect(mailboxProofOrigin('not a url')).toBe('');
  });

  it("the keystore's v2 header verifies against the relay's key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mproof2-'));
    const ks = createPairingKeystore(path.join(dir, 'keys.json'));
    const relay = generateKeyPairSync('x25519');
    const relayX = (relay.publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const body = '{"code":"c","name":"n"}';
    const [v, pub, ts, mac] = ks.mailboxProofV2(relayX, 'https://r.example', 'PUT', 1700000000, body).split('.') as [string, string, string, string];
    expect(v).toBe('v2');
    expect('cmk1.' + pub).toBe(ks.ownPublicCode());
    const clientPub = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub }, format: 'jwk' });
    const sh = diffieHellman({ privateKey: relay.privateKey, publicKey: clientPub });
    const bh = mailboxProofBodyHash('PUT', body);
    expect(mailboxProofMacV2(sh, b(pub), b(relayX), 'https://r.example', 'PUT', ks.ownRoutingId(), Number(ts), bh).toString('base64url')).toBe(mac);
  });

  it('prefers v2 when the relay answers it, signing the configured origin and the body; else falls back to v1', async () => {
    const calls: string[] = [];
    const t = 1_700_000_000_000;
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      if (url === 'https://v2.example/relay/ext/mailbox-proof/v2') {
        // A relay that reports some other origin is ignored: ORIGIN is ours.
        return new Response(JSON.stringify({ v: 2, relayKey: 'B'.repeat(43), window: 600, now: t / 1000, origin: 'https://evil' }), { status: 200 });
      }
      if (url.endsWith('/ext/mailbox-proof/v1')) {
        return new Response(JSON.stringify({ v: 1, relayKey: 'A'.repeat(43), now: t / 1000 }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const signed: unknown[][] = [];
    const p = createMailboxProofs({
      signer: () => ({
        mailboxProof: (k, m, ts) => (signed.push(['v1', k, m, ts]), `v1.x.${ts}.y`),
        mailboxProofV2: (k, o, m, ts, body) => (signed.push(['v2', k, o, m, ts, body]), `v2.x.${ts}.y`),
      }),
      fetchImpl,
      now: () => t,
    });
    expect(await p.ensure('https://v2.example/relay', {})).not.toBeNull();
    expect(p.headerFor('https://v2.example/relay', 'PUT', '{"a":1}')).toEqual({ [MAILBOX_PROOF_HEADER]: `v2.x.${t / 1000}.y` });
    expect(signed.at(-1)).toEqual(['v2', 'B'.repeat(43), 'https://v2.example', 'PUT', t / 1000, '{"a":1}']);
    expect(await p.ensure('https://v1.example/relay', {})).not.toBeNull();
    expect(p.headerFor('https://v1.example/relay', 'GET')).toEqual({ [MAILBOX_PROOF_HEADER]: `v1.x.${t / 1000}.y` });
    expect(calls).toContain('https://v1.example/relay/ext/mailbox-proof/v2');
    expect(calls.at(-1)).toBe('https://v1.example/relay/ext/mailbox-proof/v1');
  });
});
