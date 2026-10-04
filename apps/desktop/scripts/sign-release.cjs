#!/usr/bin/env node
/**
 * Release CI: sign every installer / update artifact in apps/desktop/release
 * with the UPDATE_SIGNING_KEY secret (Ed25519, PKCS#8 PEM) and write
 * `<artifact>.sig` beside it. The message format must match
 * src/update-signature.ts `signingMessage`.
 *
 *   UPDATE_SIGNING_KEY=… node apps/desktop/scripts/sign-release.cjs <version>
 *
 * Exits non-zero without the key or without anything to sign, so a release
 * can't go out unsigned by accident. Prints the .sig paths for the upload step.
 */
const { createHash, createPrivateKey, sign } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const version = process.argv[2];
const pem = process.env.UPDATE_SIGNING_KEY;
if (!version) {
  console.error('usage: sign-release.cjs <version>');
  process.exit(2);
}
if (!pem || !pem.includes('PRIVATE KEY')) {
  console.error('UPDATE_SIGNING_KEY is not set — refusing to publish unsigned artifacts.');
  process.exit(1);
}
const key = createPrivateKey(pem);
if (key.asymmetricKeyType !== 'ed25519') {
  console.error('UPDATE_SIGNING_KEY is not an Ed25519 key.');
  process.exit(1);
}

const dir = process.env.RELEASE_DIR || path.join(__dirname, '..', 'release');
const exts = ['.dmg', '.zip', '.exe', '.AppImage', '.pacman'];
const files = fs.readdirSync(dir).filter((f) => exts.some((e) => f.endsWith(e)) && f.includes(version));
if (files.length === 0) {
  console.error(`No ${version} artifacts in ${dir}.`);
  process.exit(1);
}
for (const name of files) {
  const sha512 = createHash('sha512').update(fs.readFileSync(path.join(dir, name))).digest('base64');
  const msg = Buffer.from(`cardmirror-update-v1\n${name}\n${version}\n${sha512}`, 'utf8');
  const sigPath = path.join(dir, `${name}.sig`);
  fs.writeFileSync(sigPath, sign(null, msg, key).toString('base64') + '\n');
  console.log(sigPath);
}
