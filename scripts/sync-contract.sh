#!/usr/bin/env bash
# Canonical contract lives in contracts/. The simulator watches sdk/simulator/contracts/
# and resolves the interface from a different relative depth, so rewrite the import.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
sed 's|"../sdk/solidity/ICasinoGameV2.sol"|"../../solidity/ICasinoGameV2.sol"|' \
  "$root/contracts/Relay.sol" > "$root/sdk/simulator/contracts/Relay.sol"
echo "synced -> sdk/simulator/contracts/Relay.sol"
