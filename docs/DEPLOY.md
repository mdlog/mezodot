# Deploy runbook (testnet)

Hub on **Mezo testnet**, spokes on **Base Sepolia** and **Ethereum Sepolia**. Every external address the scripts use was verified on-chain (2026-10-17/18) and is collected in `contracts/.env.example`, together with the oracle policy (Pyth Core `0x933a…1315` pushed by Mezo, Supra DORA pull `0x443A…5702`, per-feed max age and confidence caps; see [SECURITY.md](SECURITY.md#oracle-design)), the Tigris DEX, the liquidation fee and the caps. Incidents: [RUNBOOK.md](RUNBOOK.md). Revenue collection: [REVENUE.md](REVENUE.md).

## 0. Prerequisites

- A deployer wallet funded with testnet **BTC** on Mezo (gas, from https://faucet.test.mezo.org), 1 **MEZO** (faucet) and 1 **MUSD** (borrow against test BTC or swap in https://testnet.mezo.org) for the seed deposits, and Sepolia ETH on Base Sepolia and Ethereum Sepolia. The broadcasting account becomes the owner of every contract and the treasury, whatever the signer type.
- `foundry` ≥ 1.5, `jq`; Node 22 and pnpm 11 (`pnpm install`) for `pnpm verify:deployment`; `bc` and `curl` for `pnpm smoke:btc`.
- Optional check before deploying: `MEZO_FORK_RPC=https://rpc.test.mezo.org forge test --root contracts --match-contract ForkMezo -vv` runs the hub flows against live Mezo oracle state (nothing is sent; CI runs it nightly).

### Key storage

The deployer key owns every contract on three chains and is the treasury, so it can move user funds ([SECURITY.md, admin powers](SECURITY.md#admin-powers-testnet-the-deployer-eoa)). Keep it out of the repository tree and never next to its password:

- Store the encrypted keystore outside the repository, e.g. `~/.mezodot/keystores/deployer` (directory `0700`, file `0600`), and type the password when forge or cast asks for it. `cast wallet import deployer --interactive` does the same in `~/.foundry/keystores` (then sign with `--account deployer`). A hardware wallet (`--ledger`) is better still.
- Never keep a plaintext password file. If one exists (for example `.secrets/deployer.password` from an earlier setup), move the keystore out and delete the password file:

  ```bash
  install -d -m 700 ~/.mezodot/keystores
  mv .secrets/deployer ~/.mezodot/keystores/deployer && chmod 600 ~/.mezodot/keystores/deployer
  shred -u .secrets/deployer.password      # or rm -P on macOS
  ```

- `.secrets/` is git-ignored, but anything inside the repository is copied by backups, sync tools, editor indexers and a legacy (non-BuildKit) `docker build .` context. A password-file signer (`--password-file`) is for throwaway smoke-test accounts only.

The commands below sign with `--keystore $KEYSTORE`; substitute `--account deployer` or `--ledger` as you use:

```bash
KEYSTORE=~/.mezodot/keystores/deployer
set -a; source contracts/.env.example; set +a
cd contracts
```

## 1. Hub (Mezo testnet)

```bash
NETWORK=mezo-testnet WORMHOLE=$MEZO_WORMHOLE CONSISTENCY_LEVEL=1 SEED_AMOUNT=1000000000000000000 \
forge script script/DeployHub.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
```

| Variable                                              | Default            | Testnet (`contracts/.env.example`)                                   | Meaning                                                                                       |
| ----------------------------------------------------- | ------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `NETWORK`                                             | —                  | `mezo-testnet`                                                       | Deployment JSON written: `packages/sdk/src/deployments/<NETWORK>.json`                        |
| `MUSD`, `MEZO`, `BTC`                                 | —                  | `0x1189…c503`, `0x7B7c…0001`, `0x7b7C…0000`                          | Pool assets and the plain BTC collateral (both precompiles have 18 decimals)                  |
| `WORMHOLE`, `CONSISTENCY_LEVEL`                       | —, `1`             | `$MEZO_WORMHOLE`, `1`                                                | Wormhole Core and the level RELEASEs are published with                                       |
| `SEED_AMOUNT`                                         | `1e18`             | `1e18`                                                               | Seed deposit per pool, shares sent to `0x…dEaD` (`0` = none)                                  |
| `PYTH`, `SUPRA_PULL`                                  | —, none            | `0x933a…1315`, `0x443A…5702`                                         | Pyth Core; optional Supra DORA pull contract                                                  |
| `<SYM>_FEED` (MUSD, MEZO, ETH, USDC, BTC)             | —                  | Pyth price ids                                                       | Primary leg of each price key                                                                 |
| `<SYM>_MAX_AGE`, `<SYM>_MAX_CONF_BPS`                 | `120`, `200`       | 3,900 s for MUSD/MEZO/USDC, 120 s for ETH/BTC; 500 bps for MUSD/MEZO | Pyth leg max age and the feed's confidence cap                                                |
| `<SYM>_SUPRA_PAIR`, `SUPRA_MAX_AGE`, `DIVERGENCE_BPS` | none, `120`, `150` | ETH 19, USDC 89, BTC 18; `120`; `150`                                | Optional Supra secondary leg (needs `SUPRA_PULL`) and the two-leg cross-check                 |
| `TIGRIS_FACTORY`, `TIGRIS_STABLE`                     | —, `false`         | `0x4947…Ce1A`, `false`                                               | The MUSD/BTC pool for BTC leverage is `getPool(MUSD, BTC, TIGRIS_STABLE)` on this factory     |
| `TIGRIS_ROUTER`                                       | —                  | `0x9a1f…D7E9`                                                        | Recorded in the JSON for app quotes and the agent's sales of seized BTC                       |
| `LIQUIDATION_FEE_BPS`                                 | `1000`             | `1000`                                                               | Protocol share of each liquidation bonus (≤ 5,000), credited to the treasury (= the deployer) |
| `MUSD_SUPPLY_CAP`, `MUSD_BORROW_CAP`                  | 5 M, 4 M MUSD      | same                                                                 | pMUSD caps, token wei                                                                         |
| `MEZO_SUPPLY_CAP`, `MEZO_BORROW_CAP`                  | 2 B, 1 B MEZO      | same                                                                 | pMEZO caps, token wei                                                                         |
| `MEZO_COLLATERAL_CAP`, `BTC_COLLATERAL_CAP`           | 100 M MEZO, 25 BTC | same                                                                 | Collateral caps in token wei (the script converts the MEZO cap to pMEZO shares, × 10⁶)        |

Fixed in the script: rate models (MUSD 0% / 6% / kink 80% / 80%, MEZO 2% / 8% / 70% / 100%), reserve factor 10%, collateral pMUSD 80/85/5 (LTV/LT/bonus %), pMEZO 50/60/10, BTC 70/78/5. `pnpm verify:deployment` compares the live values with these (`DEPLOYED_RISK` and `DEPLOYED_RESERVE_FACTOR` in `scripts/lib/verify.ts`, which its tests pin to the scripts), so a deliberate change goes into the script and that table too.

- **Max ages.** Push feeds (MUSD, MEZO, USDC) allow 3,900 s, above the longest gap seen in Mezo's hourly push. ETH and BTC allow 120 s, the pull window: Pyth Core accepts any signed update newer than the one it stores, so a caller can pick a historical price anywhere within a leg's max age ([SECURITY.md, price pick window](SECURITY.md#price-pick-window)), and BTC is volatile collateral. The agent's keyed pusher refreshes their Pyth legs about every minute; otherwise transactions attach Supra proofs. The live v5 router took BTC's 120 s with `setFeed` on 2026-10-18.
- **pMEZO collateral cap.** The cap is fixed in pMEZO shares at the empty-pool rate (`MEZO_COLLATERAL_CAP` × 10⁶) while pMEZO's exchange rate rises with interest, so the same shares hold more MEZO over time: about 3.5% a year at 50% utilisation, about 60% at 90%; a bad-debt write-off moves it the other way. Re-set the share cap with `setCollateralParams` when the drift matters. A value above `type(uint256).max / 10⁶` means unlimited.

- `--skip-simulation` is required on Mezo: MEZO and BTC are precompiles that forge's own EVM cannot execute. The script's local run mocks their `decimals()`; with the flag, the node estimates and executes every transaction against the real precompiles.
- The script looks up the Tigris pool on the factory and stops if there is none (`TIGRIS_STABLE=true` finds no MUSD/BTC pool on testnet today).
- **The JSON is written by a broadcast during forge's local run**, before anything is mined; a dry run (no `--broadcast`) never writes it. A broadcast that dies halfway therefore leaves addresses of contracts that may not exist. Check that every transaction has a receipt and finish an interrupted run with the same command plus `--resume`:

  ```bash
  jq '(.transactions | length), (.receipts | length)' broadcast/DeployHub.s.sol/31611/run-latest.json   # must match
  ```

  `pnpm verify:deployment` (step 4) reports addresses without a contract as "no code".

- The deployer needs 1 MUSD and 1 MEZO for the seed deposits (`SEED_AMOUNT=0` to skip). The script seeds pMUSD itself; seed pMEZO with `cast`, because forge cannot send the precompile's `approve`:

  ```bash
  PMEZO=$(jq -r .contracts.pMEZO ../packages/sdk/src/deployments/mezo-testnet.json)
  cast send $MEZO "approve(address,uint256)" $PMEZO 1000000000000000000 --rpc-url $MEZO_RPC --keystore $KEYSTORE
  cast send $PMEZO "deposit(uint256,address)" 1000000000000000000 0x000000000000000000000000000000000000dEaD --rpc-url $MEZO_RPC --keystore $KEYSTORE
  ```

- `script/DeploySwapLeverage.s.sol` (`NETWORK`, `TIGRIS_STABLE`) replaces only the BTC leverage manager on a live hub and rewrites the JSON's `swapLeverageManager` and `tigrisPool`. It holds no funds or state: users approve the new address once (`setOperator` and a BTC approval).
- `script/DeployKeeperGateway.s.sol` (`NETWORK`) replaces only the `KeeperGateway` and rewrites the JSON's `keeperGateway` (testnet v5: `0x2e63…dc11`, 2026-10-18). It holds no privileges, and liquidations and relays are permissionless, so nothing migrates; its keeper statistics (`keeperCount`, the participation KPI) start from zero. Unspent BTC of a liquidation always goes back to the caller; BTC sent to the gateway by mistake goes along only when the caller accepts it, so a 1-wei donation cannot block keeper contracts that take no BTC.
- Both run like the hub script and write the JSON only on a broadcast; rebuild the agent (step 6) and the web app (step 7) afterwards, since both bake in the JSON:

  ```bash
  NETWORK=mezo-testnet forge script script/DeploySwapLeverage.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
  NETWORK=mezo-testnet forge script script/DeployKeeperGateway.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
  ```

## 2. Spokes

```bash
NETWORK=base-sepolia HUB_NETWORK=mezo-testnet WORMHOLE=$BASE_WORMHOLE WORMHOLE_CHAIN_ID=10004 WETH=$BASE_WETH USDC=$BASE_USDC \
forge script script/DeploySpoke.s.sol --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow

NETWORK=eth-sepolia HUB_NETWORK=mezo-testnet WORMHOLE=$ETH_WORMHOLE WORMHOLE_CHAIN_ID=10002 WETH=$ETH_WETH USDC=$ETH_USDC \
forge script script/DeploySpoke.s.sol --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
```

- The spoke's own chain id is read from Wormhole Core (`WORMHOLE_CHAIN_ID` is only a cross-check), and the hub chain id the gateway trusts comes from the hub's deployment JSON (`HUB_NETWORK`). With `HUB_NETWORK` set, `HUB_CHAIN_ID` is a cross-check too: a different value makes the script revert. Only without `HUB_NETWORK` is `HUB_CHAIN_ID` used (default 50). A wrong hub chain id would make every DEPOSIT unclaimable.
- Deposit caps, per spoke, where the tokens are locked: `WETH_CAP` (default 100 WETH) and `USDC_CAP` (250,000 USDC), token wei. The hub credits whatever a verified VAA proves, so these are the remote collateral caps.
- Use `--skip-simulation` here too: forge's local EVM prices contract creation with its own (Cancun) schedule, while Sepolia charges far more (node estimate for SpokeGateway: 8.4 M gas vs forge's 1.2 M; a forge-estimated creation ran out of gas on 2026-10-18).

## 3. Link hub ⇄ spokes (both directions, per spoke)

Still in `contracts/` (the script reads the deployment JSON written in steps 1–2):

```bash
for SPOKE in base-sepolia eth-sepolia; do
  RPC=$([ $SPOKE = base-sepolia ] && echo $BASE_SEPOLIA_RPC || echo $ETH_SEPOLIA_RPC)
  MODE=hub   HUB_NETWORK=mezo-testnet SPOKE_NETWORK=$SPOKE forge script script/ConfigureCrossChain.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
  MODE=spoke HUB_NETWORK=mezo-testnet SPOKE_NETWORK=$SPOKE forge script script/ConfigureCrossChain.s.sol --rpc-url $RPC      --keystore $KEYSTORE --broadcast --skip-simulation --slow
done
```

- `MODE=hub` registers the spoke emitter and adds its WETH (75/80/7) and USDC (80/85/5) as remote collateral; `MODE=spoke` registers the hub adapter as the only trusted RELEASE emitter. `--slow` waits for each receipt (a run without it once sent 3 transactions and recorded 1).
- Re-runnable: an emitter that already matches is left alone, and remote collateral that is already listed keeps its on-chain risk parameters, which may have been tuned with `setCollateralParams` since (the run logs `collateral differs from the script's risk parameters, left as is`). `RECONCILE_PARAMS=1` resets them to 75/80/7 and 80/85/5, keeping each one's cap and `enabled`.
- **Re-pointing a link.** An emitter is replaced by a different one only with `FORCE_REPOINT=1`, and only while the link backs nothing. `MODE=hub` refuses while the hub credits any WETH or USDC from that spoke chain: remote collateral ids are keyed by chain and token, so the old and the new gateway would share them, old depositors' withdrawals would be paid out of new deposits and the old gateway's tokens would stay stranded. `MODE=spoke` refuses while the gateway holds locked WETH or USDC, which only the hub that credited them can release. The check also applies to an emitter cleared by a bridge cut, so a cut link is restored by hand ([RUNBOOK.md, section 3](RUNBOOK.md#3-bridge-or-guardian-incident)). Messages are bound to their destination contract (payload v2): never re-point a deployed hub or spoke at a redeployed counterpart while messages are in flight.

## 4. Verify

From the repository root, with the deploy inputs loaded so they are compared too:

```bash
cd ..
set -a; source contracts/.env.example; set +a
pnpm verify:deployment mezo-testnet          # --brief: failures and warnings only; --json for a machine-readable report
```

`scripts/verify-deployment.ts` reads `mezo-testnet.json` and both spoke files and checks, read-only: every recorded address has code and every Mezodot contract implements the SDK ABI (catches an SDK/deployment version skew); owners (`EXPECTED_OWNER`, default the VaultManager's owner) and pending ownership transfers; VaultManager oracle, adapter, treasury (compared with `EXPECTED_TREASURY` when set; otherwise a treasury other than the owner is a warning), liquidation fee, markets, and **7 collaterals** of the right kinds (pMUSD and pMEZO shares, plain BTC, WETH and USDC per spoke) with decimals, caps, `remoteCollateralId` and the LTV, liquidation threshold and bonus the deploy scripts set; pool vault managers, reserve factors (the deployed 10%), caps, solvency and seed deposits; the Pyth and Supra sources and every price key's feed against the JSON, the SDK's Supra pairs and the loaded policy; Wormhole chain ids and emitters in both directions; LeverageManager and KeeperGateway wiring; `SwapLeverageManager.pair()` = the factory's MUSD/BTC pool = `contracts.tigrisPool`, with a pool quote equal to the router's; and per spoke the hub emitter, hub chain id, token allowlist, caps, `held ≥ locked ≥ hub credit`. Values that come from the deploy environment (feeds, caps, the fee, the risk parameters and reserve factors) are compared only when it is loaded, as above. It exits 1 on any mismatch (2 on a usage error); warnings (paused contracts, unlimited caps, stray balances, a separate treasury) do not fail it. `RPC_<NETWORK>` picks the endpoints: one URL or a comma-separated list tried in order, as for the agent.

Then run the BTC smoke test of step 8 before announcing the deployment.

Optional source verification on the explorers (not yet run for the current deployment): append `--verify --verifier blockscout --verifier-url https://explorer.test.mezo.org/api/` to the hub commands (Mezo's explorer is Blockscout), and `--verify --etherscan-api-key $ETHERSCAN_API_KEY` to the spoke commands.

## 5. Commit

Commit the three testnet deployment files as forge wrote them (without a final newline; `.prettierignore` leaves them alone, so neither `pnpm format` nor CI touches them), together with the SDK ABIs of the same contract version: the SDK, the agent and the web app read both, and a JSON from one version with ABIs from another breaks every read. CI fails when `packages/sdk/src/abis` does not match the forge build (`pnpm check:abis` locally).

```bash
git add packages/sdk/src/deployments packages/sdk/src/abis contracts/broadcast
```

## 6. Agent

```bash
cp services/agent/.env.example services/agent/.env   # KEEPER_PRIVATE_KEY, MCP_TOKEN, optional PYTH_API_KEY
docker compose up -d agent                            # HTTP + MCP on 127.0.0.1:8787; rebuilds the image (it bakes in the deployment JSON)
```

- The container listens on 0.0.0.0 and compose publishes it on `127.0.0.1:8787`: put an HTTPS reverse proxy in front. The web app needs `GET /oracle/update` whenever a price would expire before its transaction lands: ETH and BTC (120 s legs) unless the agent's pusher has just refreshed them, USDC when its push is stale (Supra's endpoint rejects browser CORS). `/health` (503 when degraded), `/oracle/health`, `/revenue` and `/metrics` are for operators.
- Configuration changes take effect only when the container is recreated: edit `services/agent/.env`, then `docker compose up -d --no-build agent` (recreates the container with the new environment without rebuilding the image; plain `up -d agent` also rebuilds from the working tree, shipping whatever code is checked out). `docker compose restart` keeps the old environment, and variables set inline on the compose command line never reach the container.
- `/mcp` is never exposed to browsers. For remote MCP clients set `MCP_TOKEN` (≥ 16 chars) and `MCP_ALLOWED_HOSTS`; write tools also need `MCP_ALLOW_WRITE=true`.
- Fund the keeper: BTC on Mezo (gas), ETH on the spokes (release relays), and MUSD/MEZO as repay inventory. Seized pMUSD/pMEZO are redeemed back into inventory, seized BTC is sold for MUSD on Tigris, and seized WETH/USDC arrive on the spoke.
- `PYTH_API_KEY` (optional, server-side only) turns on the Pyth pusher: the 120 s Pyth legs of ETH and BTC, pushed at half their max age (about every minute), and refreshes of push feeds when Mezo's pusher lags, **but only for feeds the key is entitled to**. Pyth entitles keys feed by feed; the key in use today covers ETH and BTC, not MUSD or MEZO, so those two still depend on Mezo's hourly push alone ([SECURITY.md, limitations](SECURITY.md#known-limitations)). Without the pusher, ETH and BTC are priced only by the proofs transactions attach. Check a key before relying on it (200 = entitled, 403 = not):

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $PYTH_API_KEY" \
    "https://hermes.pyth.network/v2/updates/price/latest?ids[]=$MUSD_FEED"
  ```

  The agent logs `Pyth key is not entitled to <SYMBOL>` once per feed and retries hourly. Never put the key in a `VITE_*` variable.

## 7. Web

```bash
VITE_MEZODOT_ENV=testnet VITE_AGENT_URL=https://<your-agent-host> VITE_WALLETCONNECT_PROJECT_ID=<id> pnpm --filter @mezodot/web build
# deploy apps/web/dist to any static host
```

The build bundles the deployment JSON and refuses to run without `VITE_AGENT_URL` and `VITE_WALLETCONNECT_PROJECT_ID`, or with localhost services (`apps/web/.env.example`).

## 8. Smoke test on testnet

1. `curl https://<agent>/oracle/health`: MUSD, MEZO and USDC `ok`; ETH and BTC `ok` while the agent's keyed pusher runs, `on-demand` without it (transactions then attach Supra proofs); `curl https://<agent>/health` answers 200.
2. **BTC path**, with a dedicated, funded smoke account (≈ 0.002 BTC; not the owner key), dry run first:

   ```bash
   pnpm smoke:btc --keystore <smoke-keystore> --password-file <file> --dry-run
   pnpm smoke:btc --keystore <smoke-keystore> --password-file <file>
   ```

   `scripts/smoke-btc.sh` posts BTC collateral and withdraws it (checking that the precompile moved exactly the amount of native BTC), then opens a 1.5× BTC position through `SwapLeverageManager`, closes half and closes the rest: debt equals the borrow, collateral equals principal + bought, every wallet movement matches the events, the manager keeps nothing, and the account keeps its gas reserve. Addresses come from the deployment JSON; the keystore path and password file are never printed. If pMUSD has little idle cash, add `--supply <MUSD>` (supplied first, redeemed at the end). No unit or fork test can cover this path: neither the precompile nor the real pool runs on a fork. The nightly workflow runs it too once the repository variable `BTC_SMOKE=true` and the secrets `SMOKE_KEYSTORE_JSON` and `SMOKE_KEYSTORE_PASSWORD` (the smoke account, never the owner) are set.

3. Supply a small MUSD amount on Markets; check the pMUSD exchange rate.
4. Lock 0.001 WETH on Base Sepolia; watch the lifecycle reach "Credited". Guardians sign once the spoke block is final: about 17 minutes on Base Sepolia and 14 minutes on Ethereum Sepolia (measured), less than a minute on Mezo.
5. Borrow a few MUSD against it (the transaction carries a Supra proof, ~1 M gas); repay.
6. Open a 1.5× MUSD loop and unwind it (one 0.09% flash fee in total: the unwind nets the debt against the posted pMUSD).
7. Open and close a small BTC position on the Leverage desk in the web app.
8. Liquidations: `pnpm devnet:e2e` covers the full cross-chain liquidation locally (nightly CI); on testnet, `GET /liquidatable` shows what the keeper sees.

## 9. Redeploy

A redeploy creates a new protocol: nothing migrates, the old contracts keep running, and the SDK, agent and web app only see the deployment in the JSON. In order:

1. **Announce and drain.** Ask users to close positions on the old deployment (exits never need the owner). Pause it while the JSON still points at it, so no new risk opens there (exits stay open), and wait until no message is in flight:

   ```bash
   cd contracts
   MODE=hub NETWORK=mezo-testnet forge script script/Pause.s.sol --rpc-url $MEZO_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
   MODE=spoke NETWORK=base-sepolia forge script script/Pause.s.sol --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
   MODE=spoke NETWORK=eth-sepolia forge script script/Pause.s.sol --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE --broadcast --skip-simulation --slow
   cd ..
   curl -s "https://<agent>/messages?pending=1" | jq length     # 0 before you continue
   ```

   `--skip-simulation` matters on Ethereum Sepolia: forge's own gas limit for `pause()` is about half what the chain charges, so the pause would run out of gas ([RUNBOOK.md, setup](RUNBOOK.md#setup)). `ACTION` is `pause` (default) or `unpause`; any other value is refused.

2. **Collect revenue** from the old deployment while the JSON still names it: `pnpm revenue:report mezo-testnet` and the steps in [REVENUE.md](REVENUE.md#collecting).
3. **Stop the agent** (`docker compose stop agent`, or stop `pnpm start`): it must not act on a half-written JSON.
4. **Contracts and ABIs:** `forge build --root contracts && pnpm --filter @mezodot/sdk gen:abis && pnpm exec prettier --write packages/sdk/src/abis`, then `pnpm check:abis`.
5. **Deploy** the hub (step 1, including the pMEZO seed), both spokes (step 2) and the links (step 3). To keep the live spokes instead (a hub-only redeploy, as for testnet v5), skip step 2 and run step 3 with `FORCE_REPOINT=1` for `MODE=spoke`: it re-points a spoke only once nothing is locked in it any more, i.e. every old-hub position with collateral on that spoke has been withdrawn or liquidated and its RELEASE delivered (step 1's drain; the spoke section of `pnpm verify:deployment` shows what is still locked). `MODE=hub` needs no flag there: the new adapter has no spoke emitter yet and the new hub credits nothing.
6. **Verify** (step 4): zero failures.
7. **Reset the agent's state.** Its cursors and indexes belong to the old contracts. The agent archives them by itself when the deployment changes, but start clean anyway (the risk report cache can stay). For a hub-only redeploy that keeps the spokes, keep `relayer-<env>.json`: its spoke cursors still belong to the reused gateways, and the agent resets the hub cursor and archives messages addressed to the old hub on its own; move only the liquidator and revenue files:

   ```bash
   STATE=services/agent/.state                 # Docker: the agent-state volume, mounted at /data
   mkdir -p $STATE/archive-$(date +%F)
   # Hub and spokes redeployed:
   mv $STATE/relayer-testnet*.json $STATE/liquidator-testnet*.json $STATE/revenue-testnet*.json $STATE/archive-$(date +%F)/ 2>/dev/null
   # Hub-only redeploy (spokes kept): leave relayer-testnet.json in place.
   mv $STATE/liquidator-testnet*.json $STATE/revenue-testnet*.json $STATE/archive-$(date +%F)/ 2>/dev/null
   ```

8. **Restart the agent** (`docker compose up -d agent` rebuilds the image with the new JSON) and wait for `/health` 200.
9. **Rebuild and publish the web app** (step 7): it bundles the JSON.
10. **Smoke test** (step 8) and **commit** (step 5).

## 10. Ownership transfer and key rotation

Every owned contract uses `Ownable2Step`: the current owner proposes, the new owner accepts. Seven contracts on three chains: VaultManager, OracleRouter, WormholeAdapter, pMUSD and pMEZO on Mezo, and one SpokeGateway on each spoke. `LeverageManager`, `SwapLeverageManager` and `KeeperGateway` have no owner. From the repository root:

```bash
NEW_OWNER=0x...   # hardware wallet or multisig
HUB=packages/sdk/src/deployments/mezo-testnet.json
for key in vaultManager oracleRouter wormholeAdapter pMUSD pMEZO; do
  cast send "$(jq -r .contracts.$key $HUB)" "transferOwnership(address)" $NEW_OWNER --rpc-url $MEZO_RPC --keystore $KEYSTORE
done
cast send "$(jq -r .contracts.spokeGateway packages/sdk/src/deployments/base-sepolia.json)" "transferOwnership(address)" $NEW_OWNER --rpc-url $BASE_SEPOLIA_RPC --keystore $KEYSTORE
cast send "$(jq -r .contracts.spokeGateway packages/sdk/src/deployments/eth-sepolia.json)" "transferOwnership(address)" $NEW_OWNER --rpc-url $ETH_SEPOLIA_RPC --keystore $KEYSTORE
# then the same seven contracts, signed by the new owner: cast send <contract> "acceptOwnership()" ...
EXPECTED_OWNER=$NEW_OWNER pnpm verify:deployment mezo-testnet   # every owner() is the new key, no pendingOwner left
```

- Until `acceptOwnership`, the old key stays owner and a second `transferOwnership` replaces the pending owner. `verify:deployment` warns about every contract with a pending transfer.
- The treasury is separate: `VaultManager.setTreasury(<new>)` redirects future liquidation fees only. Withdraw what the old treasury account holds first ([REVENUE.md](REVENUE.md#collecting)). Until then `verify:deployment` warns that the treasury is not the owner; afterwards check it with `EXPECTED_OWNER=$NEW_OWNER EXPECTED_TREASURY=<new> pnpm verify:deployment mezo-testnet`.
- Pin both for the nightly check: set the repository variables `EXPECTED_OWNER` and `EXPECTED_TREASURY` (GitHub: Settings → Secrets and variables → Actions → Variables). Unset, the nightly takes the VaultManager's owner as the expected owner and only warns about a treasury that differs from it.
- Never call `renounceOwnership`: it removes the pause, oracle and bridge levers for good.
- Key compromise: [RUNBOOK.md](RUNBOOK.md#7-key-compromise).
