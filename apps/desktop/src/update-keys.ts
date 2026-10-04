import type { TrustedUpdateKey } from './update-signature.js';

/**
 * Public keys whose signatures this build accepts on an update
 * (see update-signature.ts). An update that none of them signed is refused,
 * whatever its source. To trust another stream's releases (e.g. the
 * official ones, if they start signing), add its key here.
 *
 * The matching private keys live only in the release repository's
 * `UPDATE_SIGNING_KEY` secret (and the owner's offline backup). Generate one
 * with `node apps/desktop/scripts/gen-update-key.cjs`.
 */
export const TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey[] = [];
