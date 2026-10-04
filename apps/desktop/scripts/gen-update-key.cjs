#!/usr/bin/env node
/**
 * One-time: make the Ed25519 key that signs this fork's releases.
 *
 *   node apps/desktop/scripts/gen-update-key.cjs [--repo owner/repo] [--out <file>] [--id <label>]
 *
 * - Writes the PRIVATE key (PKCS#8 PEM, mode 600) to --out (default
 *   ~/cardmirror-update-signing-key.pem) and refuses to overwrite one. Move it
 *   into a password manager afterwards: lose it and installs can't be updated
 *   again without a manual reinstall.
 * - Stores the same private key in the repository's UPDATE_SIGNING_KEY Actions
 *   secret via `gh secret set` (stdin — it never appears on a command line).
 * - Adds the PUBLIC key to apps/desktop/src/update-keys.ts, so builds made
 *   from then on trust it, and prints it.
 */
const { generateKeyPairSync } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const repo = arg('repo', 'brian-cai/cardmirror');
const out = path.resolve(arg('out', path.join(os.homedir(), 'cardmirror-update-signing-key.pem')));
const id = arg('id', `${repo.split('/')[0]} ${new Date().toISOString().slice(0, 10)}`);

if (fs.existsSync(out)) {
  console.error(`Refusing to overwrite ${out} — it may be the key your installs already trust.`);
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

fs.writeFileSync(out, pem, { mode: 0o600 });
console.log(`Private key written to ${out} (mode 600).`);

try {
  execFileSync('gh', ['secret', 'set', 'UPDATE_SIGNING_KEY', '--repo', repo], { input: pem, stdio: ['pipe', 'inherit', 'inherit'] });
  console.log(`Stored as the UPDATE_SIGNING_KEY secret on ${repo}.`);
} catch {
  console.error(`Couldn't set the secret with gh — set UPDATE_SIGNING_KEY on ${repo} to the contents of ${out} by hand.`);
}

const keysFile = path.join(__dirname, '..', 'src', 'update-keys.ts');
const src = fs.readFileSync(keysFile, 'utf8');
const entry = `  { id: ${JSON.stringify(id)}, spki: ${JSON.stringify(spki)} },\n`;
const next = src.replace(
  /export const TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey\[\] = \[(\]|\n)/,
  (m, tail) => (tail === ']' ? `export const TRUSTED_UPDATE_KEYS: readonly TrustedUpdateKey[] = [\n${entry}]` : `${m}${entry}`),
);
if (next === src) {
  console.error(`Couldn't edit ${keysFile}; add this entry to TRUSTED_UPDATE_KEYS by hand:\n${entry}`);
} else {
  fs.writeFileSync(keysFile, next);
  console.log(`Public key added to ${path.relative(process.cwd(), keysFile)}:`);
  console.log(entry.trim());
}
console.log('\nNext: move the private key file into your password manager, then delete it from disk.');
