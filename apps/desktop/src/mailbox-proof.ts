/**
 * Mailbox proof v2 / v1 (an optional relay extension; xtgg relay
 * docs/mailbox-proof-v2.md, -v1.md). A relay that advertises it at
 * `GET /ext/mailbox-proof/v2` (preferred) or `/v1` lets this machine prove it holds the key
 * behind its routing code; once proven, that relay lets only this machine
 * delete its waiting cards and write its team-list entry. Send codes are
 * shared on purpose, so without this anyone with a token could do both.
 *
 * Per relay base URL: the relay's key and clock offset, re-discovered every
 * few hours. A relay that doesn't answer 200 gets no proofs (the base
 * protocol, exactly as before), asked again an hour later. Each proof is
 * one call's: it names the method and is good for minutes. A v2 proof
 * also names the relay's origin (from the URL configured here, never
 * from the relay) and, for a PUT, the hash of the exact body sent; for a
 * DELETE, the message id or team-list code it deletes.
 */
import { mailboxProofOrigin } from './pairing-crypto.js';

export interface ProofSigner {
  mailboxProof(relayKey: string, method: string, ts: number): string;
  mailboxProofV2?(relayKey: string, origin: string, method: string, ts: number, body?: string | Uint8Array, target?: string): string;
}

type Info = { v: 1 | 2; relayKey: string; skewS: number } | null;

const FRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

export const MAILBOX_PROOF_HEADER = 'X-Mailbox-Proof';

export function createMailboxProofs(opts: {
  signer: () => ProofSigner;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const known = new Map<string, { info: Info; at: number }>();
  const pending = new Map<string, Promise<Info>>();

  async function discoverVersion(base: string, headers: Record<string, string>, v: 1 | 2): Promise<Info> {
    try {
      const res = await fetchImpl(`${base}/ext/mailbox-proof/v${v}`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {});
        return null;
      }
      const body = (await res.json()) as { v?: unknown; relayKey?: unknown; now?: unknown };
      if (body?.v !== v || typeof body.relayKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.relayKey)) return null;
      const skewS = typeof body.now === 'number' ? body.now - Math.floor(now() / 1000) : 0;
      return { v, relayKey: body.relayKey, skewS };
    } catch {
      return null;
    }
  }

  /** v2 when the relay answers it (and this signer and URL can make one),
   *  else v1 as before. */
  async function discover(base: string, headers: Record<string, string>): Promise<Info> {
    if (opts.signer().mailboxProofV2 && mailboxProofOrigin(base)) {
      const v2 = await discoverVersion(base, headers, 2);
      if (v2) return v2;
    }
    return discoverVersion(base, headers, 1);
  }

  /** Learn (or refresh) what `base` supports. Never throws. */
  async function ensure(base: string, headers: Record<string, string>): Promise<Info> {
    const k = known.get(base);
    if (k && now() - k.at < (k.info ? FRESH_MS : RETRY_MS)) return k.info;
    let p = pending.get(base);
    if (!p) {
      p = discover(base, headers).then((info) => {
        known.set(base, { info, at: now() });
        pending.delete(base);
        return info;
      });
      pending.set(base, p);
    }
    return p;
  }

  /** The header for one call, from what is already known ({} if nothing).
   *  `body`: a PUT's exact request body (v2 signs its hash). `target`: what
   *  a DELETE deletes, URL-decoded (v2 signs it): the message id, or the
   *  code of a team-list entry. */
  function headerFor(base: string, method: string, body?: string | Uint8Array, target?: string): Record<string, string> {
    const info = known.get(base)?.info;
    if (!info) return {};
    const ts = Math.floor(now() / 1000) + info.skewS;
    try {
      const signer = opts.signer();
      if (info.v === 2) {
        const origin = mailboxProofOrigin(base);
        if (!origin || !signer.mailboxProofV2) return {};
        return { [MAILBOX_PROOF_HEADER]: signer.mailboxProofV2(info.relayKey, origin, method, ts, body, target) };
      }
      return { [MAILBOX_PROOF_HEADER]: signer.mailboxProof(info.relayKey, method, ts) };
    } catch {
      return {};
    }
  }

  /** A relay refused a proof (403 naming it): ask it again next time. */
  function forget(base: string): void {
    known.delete(base);
  }

  return { ensure, headerFor, forget };
}
