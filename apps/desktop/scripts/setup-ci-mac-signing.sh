#!/bin/bash
# One-time: give a fork's release CI a stable macOS signing identity.
#
#   bash apps/desktop/scripts/setup-ci-mac-signing.sh [--repo owner/repo] [--backup <dir>]...
#
# Makes a self-signed "CardMirror Local Signing" code-signing certificate
# (the name scripts/sign-mac.js looks for), and stores it in the repo's
# MAC_SIGNING_CERT_P12 / MAC_SIGNING_CERT_PASSWORD Actions secrets, which
# release.yml imports before building. The .p12 (encrypted with a random
# password) is copied to your home folder and every --backup folder (e.g.
# Dropbox); the password goes ONLY to a file in your home folder, for your
# password manager — never next to the cloud copies.
#
# Why it matters: an ad-hoc signature changes the app's identity on every
# build (macOS forgets the microphone grant on each update), and a stable
# identity lets the update swap (mac-swap-update.ts) refuse any bundle not
# signed by the same certificate. Once your installs carry this identity,
# every later update MUST be signed with it — keep the backups.
#
# Requires: openssl, gh (logged in). Refuses to overwrite an existing backup.
set -euo pipefail
REPO="brian-cai/cardmirror"
DIRS=("$HOME")
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift 2 ;;
    --backup) DIRS+=("${2/#\~/$HOME}"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
IDENTITY="CardMirror Local Signing"
NAME="cardmirror-mac-signing.p12"
PASSFILE="$HOME/cardmirror-mac-signing.password.txt"

for d in "${DIRS[@]}"; do
  if [ -e "$d/$NAME" ]; then
    echo "Refusing to overwrite $d/$NAME — your builds may already be signed with it." >&2
    exit 1
  fi
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

cat > cert.cnf <<CNF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = $IDENTITY
[ v3 ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

PASS="$(openssl rand -base64 24)"
openssl req -x509 -newkey rsa:3072 -keyout key.pem -out cert.pem -days 3650 -nodes -config cert.cnf >/dev/null 2>&1
# Legacy PBE so macOS's keychain (the CI runner's `security import`) accepts it.
openssl pkcs12 -export -inkey key.pem -in cert.pem -out identity.p12 \
  -passout "pass:$PASS" -name "$IDENTITY" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 2>/dev/null \
  || openssl pkcs12 -export -legacy -inkey key.pem -in cert.pem -out identity.p12 -passout "pass:$PASS" -name "$IDENTITY"

base64 < identity.p12 | tr -d '\n' | gh secret set MAC_SIGNING_CERT_P12 --repo "$REPO"
printf '%s' "$PASS" | gh secret set MAC_SIGNING_CERT_PASSWORD --repo "$REPO"

for d in "${DIRS[@]}"; do
  mkdir -p "$d"
  install -m 600 identity.p12 "$d/$NAME"
  echo "Backup: $d/$NAME"
done
umask 077
printf '%s\n' "$PASS" > "$PASSFILE"

echo "Stored MAC_SIGNING_CERT_P12 and MAC_SIGNING_CERT_PASSWORD on $REPO."
echo "The .p12 password is in $PASSFILE — put it in your password manager, then delete that file."
echo "Certificate SHA-256: $(openssl x509 -in cert.pem -noout -fingerprint -sha256 | cut -d= -f2)"
