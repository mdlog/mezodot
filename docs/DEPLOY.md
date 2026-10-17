# Deploy runbook (testnet)

Hub on **Mezo testnet**, spokes on **Base Sepolia** and **Ethereum Sepolia**. All addresses below were verified on-chain on 2026-10-17 and are collected in `contracts/.env.example`.

## 0. Prerequisites

- A deployer wallet funded with: testnet **BTC** on Mezo (gas, from https://faucet.test.mezo.org), **MEZO** (faucet) and a little **MUSD** (borrow against test BTC or swap in https://testnet.mezo.org) for the 1-token seed deposits; Sepolia ETH on Base Sepolia and Ethereum Sepolia.
- `foundry` ≥ 1.5, `jq`. Use a keystore (`cast wallet import deployer --interactive`) rather than a raw key.

```bash
set -a; source contracts/.env.example; set +a
cd contracts
```

## 1. Hub (Mezo testnet)

```bash
NETWORK=mezo-testnet WORMHOLE=$MEZO_WORMHOLE CONSISTENCY_LEVEL=1 SEED_AMOUNT=1000000000000000000 \
forge script script/DeployHub.s.sol --rpc-url $MEZO_RPC --account deployer --broadcast --slow
```

Writes `packages/sdk/src/deployments/mezo-testnet.json`. The deployer needs 1 MUSD and 1 MEZO for the seed deposits (`SEED_AMOUNT=0` to skip).

## 2. Spokes

```bash
NETWORK=base-sepolia WORMHOLE=$BASE_WORMHOLE WORMHOLE_CHAIN_ID=10004 WETH=$BASE_WETH USDC=$BASE_USDC \
forge script script/DeploySpoke.s.sol --rpc-url $BASE_SEPOLIA_RPC --account deployer --broadcast --slow

NETWORK=eth-sepolia WORMHOLE=$ETH_WORMHOLE WORMHOLE_CHAIN_ID=10002 WETH=$ETH_WETH USDC=$ETH_USDC \
forge script script/DeploySpoke.s.sol --rpc-url $ETH_SEPOLIA_RPC --account deployer --broadcast --slow
```

Optional caps: `WETH_CAP`, `USDC_CAP` (token units).

## 3. Link hub ⇄ spokes (both directions, per spoke)

```bash
for SPOKE in base-sepolia eth-sepolia; do
  RPC=$([ $SPOKE = base-sepolia ] && echo $BASE_SEPOLIA_RPC || echo $ETH_SEPOLIA_RPC)
  MODE=hub   HUB_NETWORK=mezo-testnet SPOKE_NETWORK=$SPOKE forge script script/ConfigureCrossChain.s.sol --rpc-url $MEZO_RPC --account deployer --broadcast
  MODE=spoke HUB_NETWORK=mezo-testnet SPOKE_NETWORK=$SPOKE forge script script/ConfigureCrossChain.s.sol --rpc-url $RPC      --account deployer --broadcast
done
```

`MODE=hub` registers the spoke emitter and adds its WETH (75/80/7%) and USDC (80/85/5%) as remote collateral; it is idempotent.

## 4. Verify

```bash
VM=$(jq -r .contracts.vaultManager ../packages/sdk/src/deployments/mezo-testnet.json)
cast call $VM "collateralCount()(uint256)" --rpc-url $MEZO_RPC   # expect 6 (pMUSD, pMEZO, 2×WETH, 2×USDC)
cast call $VM "marketCount()(uint256)" --rpc-url $MEZO_RPC       # expect 2
```

Commit the four deployment JSON files — the SDK, agent and web read them.

## 5. Agent

```bash
cp services/agent/.env.example services/agent/.env   # set KEEPER_PRIVATE_KEY (fund: BTC on Mezo, ETH on spokes, some MUSD)
docker compose up -d agent                            # HTTP + MCP on 127.0.0.1:8787
```

The keeper key is only needed for relaying and liquidations; without it the agent serves risk data read-only.

## 6. Web

```bash
VITE_MEZODOT_ENV=testnet VITE_AGENT_URL=https://<your-agent-host> VITE_WALLETCONNECT_PROJECT_ID=<id> pnpm --filter @mezodot/web build
# deploy apps/web/dist to any static host
```

## 7. Smoke test on testnet

1. Supply a small MUSD amount on Markets; check the pMUSD exchange rate.
2. Lock 0.001 WETH on Base Sepolia; watch the lifecycle reach "Credited" (Wormhole testnet finality on Base Sepolia takes several minutes with consistency level 1).
3. Borrow a few MUSD; repay.
4. Open a 1.5× loop and unwind it.
