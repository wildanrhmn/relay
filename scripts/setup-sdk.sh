#!/usr/bin/env bash
# The Chain casino SDK is not vendored into this repo. Fetch it once; the
# simulator, the differential test and the contract compile all resolve into it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -d "$root/sdk/simulator" ]; then echo "sdk already present"; else
  tmp="$(mktemp -d)"
  curl -fsSL https://sdk.chain.wtf/sdk/casino-sdk.zip -o "$tmp/casino-sdk.zip"
  unzip -q "$tmp/casino-sdk.zip" -d "$tmp"
  mv "$tmp/casino-sdk" "$root/sdk"
  rm -rf "$tmp"
fi
cd "$root/sdk" && npm install
"$root/scripts/sync-contract.sh"
