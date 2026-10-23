/**
 * Mailbox proof v1 (an optional relay extension; xtgg relay
 * docs/mailbox-proof-v1.md). A relay that advertises it at
 * `GET /ext/mailbox-proof/v1` lets this machine prove it holds the key
 * behind its routing code; once proven, that relay lets only this machine
 * delete its waiting cards and write its team-list entry. Send codes are
 * shared on purpose, so without this anyone with a token could do both.
 *
 * Per relay base URL: the relay's key and clock offset, re-discovered every
 * few hours. A relay that doesn't answer 200 gets no proofs (the base
 * protocol, exactly as before), asked again an hour later. Each proof is
 * one call's: it names the method and is good for minutes.
 */

export interface ProofSigner {
  mailboxProof(relayKey: string, method: string, ts: number): string;
}

type Info = { relayKey: string; skewS: number } | null;

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

  async function discover(base: string, headers: Record<string, string>): Promise<Info> {
    try {
      const res = await fetchImpl(`${base}/ext/mailbox-proof/v1`, { headers, signal: AbortSignal.timeout(8000) });
      if (res.status !== 200) {
        void res.body?.cancel().catch(() => {});
        return null;
      }
      const body = (await res.json()) as { v?: unknown; relayKey?: unknown; now?: unknown };
      if (body?.v !== 1 || typeof body.relayKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.relayKey)) return null;
      const skewS = typeof body.now === 'number' ? body.now - Math.floor(now() / 1000) : 0;
      return { relayKey: body.relayKey, skewS };
    } catch {
      return null;
    }
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

  /** The header for one call, from what is already known ({} if nothing). */
  function headerFor(base: string, method: string): Record<string, string> {
    const info = known.get(base)?.info;
    if (!info) return {};
    const ts = Math.floor(now() / 1000) + info.skewS;
    try {
      return { [MAILBOX_PROOF_HEADER]: opts.signer().mailboxProof(info.relayKey, method, ts) };
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
