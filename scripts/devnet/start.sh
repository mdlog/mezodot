#!/usr/bin/env bash
# Local two-chain devnet: anvil "Mezo hub" (31337, Wormhole chain 50) + anvil "Base spoke"
# (31338, Wormhole chain 10004). Deploys mocks for external dependencies, then runs the same
# production deploy/configure scripts used for testnet. State lives in .devnet/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STATE="$ROOT/.devnet"
CONTRACTS="$ROOT/contracts"
HUB_RPC="http://127.0.0.1:8545"
SPOKE_RPC="http://127.0.0.1:8546"
# Default anvil account #0 (deployer) and #9 (dev Wormhole guardian). Public test keys — never use elsewhere.
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
GUARDIAN_KEY="0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
GUARDIAN="$(cast wallet address --private-key "$GUARDIAN_KEY")"

# Real Pyth feed ids (the devnet price service serves these ids).
export MUSD_FEED=0x0617a9b725011a126a2b9fd53563f4236501f32cf76d877644b943394606c6de
export MEZO_FEED=0x80beaaedbdd228e77c5d62dfcd74b0305674b7e27a5cc6a46e71bd3a696826df
export ETH_FEED=0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace
export USDC_FEED=0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a
# Same oracle layout as testnet: ETH and USDC get a Supra secondary leg (MockSupraPull, served by the agent).
export ETH_SUPRA_PAIR=19
export USDC_SUPRA_PAIR=89
export MUSD_MAX_CONF_BPS=500
export MEZO_MAX_CONF_BPS=500

mkdir -p "$STATE"
"$ROOT/scripts/devnet/stop.sh" >/dev/null 2>&1 || true

# Blocks every 2 s like Mezo (plus instant mining for transactions), so block.timestamp tracks the wall clock:
# pull-oracle proofs are stamped "now" and Supra rejects timestamps more than 15 s ahead of the block.
ANVIL_MINING=(--block-time 2 --mixed-mining)
anvil --port 8545 --chain-id 31337 "${ANVIL_MINING[@]}" --silent > "$STATE/hub.log" 2>&1 & echo $! > "$STATE/hub.pid"
anvil --port 8546 --chain-id 31338 "${ANVIL_MINING[@]}" --silent > "$STATE/spoke.log" 2>&1 & echo $! > "$STATE/spoke.pid"
for rpc in "$HUB_RPC" "$SPOKE_RPC"; do
  for _ in $(seq 1 50); do cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break; sleep 0.2; done
done

forge_script() { (cd "$CONTRACTS" && forge script "$@" --private-key "$DEPLOYER_KEY" --broadcast --slow 2>&1); }
# Extracts KEY=0x... lines logged by DevnetMocks.
read_mocks() { grep -Eo '[A-Z_]+=0x[0-9a-fA-F]{40}' | sed 's/^/export /'; }

echo "› deploying hub mocks + hub"
eval "$(ROLE=hub WORMHOLE_CHAIN_ID=50 GUARDIAN=$GUARDIAN forge_script script/DevnetMocks.s.sol --rpc-url "$HUB_RPC" | read_mocks)"
NETWORK=devnet-hub SEED_AMOUNT=1000000000000000000 forge_script script/DeployHub.s.sol --rpc-url "$HUB_RPC" > "$STATE/deploy-hub.log"
HUB_MUSD=$MUSD; HUB_MEZO=$MEZO

echo "› deploying spoke mocks + spoke"
eval "$(ROLE=spoke WORMHOLE_CHAIN_ID=10004 GUARDIAN=$GUARDIAN forge_script script/DevnetMocks.s.sol --rpc-url "$SPOKE_RPC" | read_mocks)"
NETWORK=devnet-spoke WORMHOLE_CHAIN_ID=10004 forge_script script/DeploySpoke.s.sol --rpc-url "$SPOKE_RPC" > "$STATE/deploy-spoke.log"

echo "› linking hub <-> spoke"
MODE=hub HUB_NETWORK=devnet-hub SPOKE_NETWORK=devnet-spoke forge_script script/ConfigureCrossChain.s.sol --rpc-url "$HUB_RPC" >/dev/null
MODE=spoke HUB_NETWORK=devnet-hub SPOKE_NETWORK=devnet-spoke forge_script script/ConfigureCrossChain.s.sol --rpc-url "$SPOKE_RPC" >/dev/null

echo "› seeding hub liquidity"
DEP="packages/sdk/src/deployments/devnet-hub.json"
PMUSD=$(jq -r .contracts.pMUSD "$ROOT/$DEP"); PMEZO=$(jq -r .contracts.pMEZO "$ROOT/$DEP")
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_KEY")
send() { cast send --rpc-url "$HUB_RPC" --private-key "$DEPLOYER_KEY" "$@" >/dev/null; }
send "$HUB_MUSD" "approve(address,uint256)" "$PMUSD" 500000ether
send "$PMUSD" "deposit(uint256,address)" 500000ether "$DEPLOYER"
send "$HUB_MEZO" "approve(address,uint256)" "$PMEZO" 50000000ether
send "$PMEZO" "deposit(uint256,address)" 50000000ether "$DEPLOYER"

cat > "$STATE/env" <<ENV
HUB_RPC=$HUB_RPC
SPOKE_RPC=$SPOKE_RPC
DEVNET_GUARDIAN_KEY=$GUARDIAN_KEY
DEVNET_DEPLOYER_KEY=$DEPLOYER_KEY
ENV
echo "✓ devnet ready — hub $HUB_RPC, spoke $SPOKE_RPC (deployments in packages/sdk/src/deployments/devnet-*.json)"
