# Deploy runbook (testnet)

Hub on **Mezo testnet**, spokes on **Base Sepolia** and **Ethereum Sepolia**. All addresses below were verified on-chain (2026-10-17/18) and are collected in `contracts/.env.example`, including the oracle policy (Pyth Core `0x933a…1315` pushed by Mezo, Supra DORA pull `0x443A…5702`, per-feed max age and confidence caps — see `docs/SECURITY.md`).

## 0. Prerequisites

- A deployer wallet funded with: testnet **BTC** on Mezo (gas, from https://faucet.test.mezo.org), **MEZO** (faucet) and a little **MUSD** (borrow against test BTC or swap in https://testnet.mezo.org) for the 1-token seed deposits; Sepolia ETH on Base Sepolia and Ethereum Sepolia.
- `foundry` ≥ 1.5, `jq`. Use a keystore (`cast wallet import deployer --interactive`) rather than a raw key. The scripts make the broadcasting account the owner of every contract, whatever the signer type.
- Optional check before deploying: `MEZO_FORK_RPC=https://rpc.test.mezo.org forge test --root contracts --match-contract ForkMezo -vv` runs the hub flows against live Mezo oracle state (nothing is sent).

```bash
set -a; source contracts/.env.example; set +a
cd contracts
```

## 1. Hub (Mezo testnet)

```bash
NETWORK=mezo-testnet WORMHOLE=$MEZO_WORMHOLE CONSISTENCY_LEVEL=1 SEED_AMOUNT=1000000000000000000 \
forge script script/DeployHub.s.sol --rpc-url $MEZO_RPC --account deployer --broadcast --skip-simulation --slow
```

- `--skip-simulation` is required on Mezo: MEZO (`0x7B7c…0001`) is a precompile that forge's own EVM cannot execute. The script's local run mocks the few MEZO calls it makes; with the flag, transactions are estimated and executed by the node against the real precompile.
- Writes `packages/sdk/src/deployments/mezo-testnet.json`. A run without `--broadcast` writes it too: restore it with `git checkout packages/sdk/src/deployments/mezo-testnet.json` after a dry run.
- The deployer needs 1 MUSD and 1 MEZO for the seed deposits (`SEED_AMOUNT=0` to skip).

## 2. Spokes

```bash
NETWORK=base-sepolia WORMHOLE=$BASE_WORMHOLE WORMHOLE_CHAIN_ID=10004 WETH=$BASE_WETH USDC=$BASE_USDC \
forge script script/DeploySpoke.s.sol --rpc-url $BASE_SEPOLIA_RPC --account deployer --broadcast --slow

NETWORK=eth-sepolia WORMHOLE=$ETH_WORMHOLE WORMHOLE_CHAIN_ID=10002 WETH=$ETH_WETH USDC=$ETH_USDC \
forge script script/DeploySpoke.s.sol --rpc-url $ETH_SEPOLIA_RPC --account deployer --broadcast --slow
```

`WORMHOLE_CHAIN_ID` is only a cross-check: the chain id is read from Wormhole Core. Optional caps: `WETH_CAP`, `USDC_CAP` (token units).

## 3. Link hub ⇄ spokes (both directions, per spoke)

Run from `contracts/` (the scripts read the deployment JSON written in steps 1–2):

```bash
for SPOKE in base-sepolia eth-sepolia; do
  RPC=$([ $SPOKE = base-sepolia ] && echo $BASE_SEPOLIA_RPC || echo $ETH_SEPOLIA_RPC)
  MODE=hub   HUB_NETWORK=mezo-testnet SPOKE_NETWORK=$SPOKE forge script script/ConfigureCrossChain.s.sol --rpc-url $MEZO_RPC --account deployer --broadcast
  MODE=spoke HUB_NETWORK=mezo-testnet SPOKE_NETWORK=$SPOKE forge script script/ConfigureCrossChain.s.sol --rpc-url $RPC      --account deployer --broadcast
done
```

`MODE=hub` registers the spoke emitter and adds its WETH (75/80/7%) and USDC (80/85/5%) as remote collateral; it is idempotent. Messages are bound to their destination contract (payload v2): never re-point a deployed hub or spoke at a redeployed counterpart while messages are in flight.

## 4. Verify

```bash
VM=$(jq -r .contracts.vaultManager ../packages/sdk/src/deployments/mezo-testnet.json)
cast call $VM "collateralCount()(uint256)" --rpc-url $MEZO_RPC   # expect 6 (pMUSD, pMEZO, 2×WETH, 2×USDC)
cast call $VM "marketCount()(uint256)" --rpc-url $MEZO_RPC       # expect 2
OR=$(jq -r .contracts.oracleRouter ../packages/sdk/src/deployments/mezo-testnet.json)
cast call $OR "getPriceInfo(bytes32)(bool,uint256,uint256)" $(cast keccak MUSD) --rpc-url $MEZO_RPC  # true, ~0.99e18, valid-until
```

Commit the four deployment JSON files — the SDK, agent and web read them.

## 5. Agent

Back in the repository root:

```bash
cd ..
cp services/agent/.env.example services/agent/.env   # KEEPER_PRIVATE_KEY, MCP_TOKEN, optional PYTH_API_KEY
docker compose up -d agent                            # HTTP + MCP on 127.0.0.1:8787
```

- The container listens on 0.0.0.0 and compose publishes it on `127.0.0.1:8787`: put an HTTPS reverse proxy in front. The web app needs `GET /oracle/update` for every action that touches ETH/USDC prices (Supra's endpoint rejects browser CORS), and `/oracle/health` shows feed status.
- `/mcp` is never exposed to browsers. For remote MCP clients set `MCP_TOKEN` (≥ 16 chars) and `MCP_ALLOWED_HOSTS`; write tools also need `MCP_ALLOW_WRITE=true`.
- Fund the keeper: BTC on Mezo (gas), ETH on the spokes (release relays), and MUSD/MEZO as repay inventory. Seized pMUSD/pMEZO are redeemed back into inventory; seized WETH/USDC arrive on the spoke. `/health` shows the inventory.
- `PYTH_API_KEY` (optional, server-side only) turns on the Pyth pusher: ETH's Pyth leg and refreshes of MUSD/MEZO/USDC when Mezo's pusher lags. Never put it in a `VITE_*` variable.

## 6. Web

```bash
VITE_MEZODOT_ENV=testnet VITE_AGENT_URL=https://<your-agent-host> VITE_WALLETCONNECT_PROJECT_ID=<id> pnpm --filter @mezodot/web build
# deploy apps/web/dist to any static host
```

## 7. Smoke test on testnet

1. `curl https://<agent>/oracle/health`: MUSD/MEZO/USDC `ok`, ETH `on-demand`.
2. Supply a small MUSD amount on Markets; check the pMUSD exchange rate.
3. Lock 0.001 WETH on Base Sepolia; watch the lifecycle reach "Credited" (Wormhole testnet finality on Base Sepolia takes several minutes with consistency level 1).
4. Borrow a few MUSD against it (the transaction carries a Supra proof, ~1 M gas); repay.
5. Open a 1.5× loop and unwind it (MUSD prices come from Mezo's push: no proof attached).
