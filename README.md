# Mezodot Protocol

**An omnichain money market that makes MUSD and MEZO productive, composable capital — native to Mezo.**

Supply MUSD or MEZO and receive ERC-4626 **pMUSD / pMEZO**. Borrow MUSD or MEZO on the Mezo Hub against pTokens, against **BTC** held on the hub, _or_ against WETH/USDC that never leaves **Base Sepolia / Ethereum Sepolia** (Wormhole-verified collateral). Go **long BTC in one transaction** through a Tigris flash swap, or open a **1-click MUSD loop** on the pool's own flash loan and unwind it by netting debt against the posted pMUSD. Permissionless **keeper agents** liquidate and relay, and an **MCP server** exposes markets, positions and quantitative risk (volatility, VaR-based LTV advice, walk-forward + Deflated Sharpe) to AI agents. Protocol revenue (reserve factor, flash fee, a share of each liquidation bonus) accrues on-chain and is reported per pool and per collateral.

Mezo Buildathon · Track 1 (DeFi: borrowing, lending, looping, yield).

```
   Base Sepolia / Ethereum Sepolia                 Mezo (Hub)
  ┌──────────────────────────┐   Wormhole VAA   ┌────────────────────────────────────────────────┐
  │ SpokeGateway             │ ───DEPOSIT─────▶ │ WormholeAdapter ─▶ VaultManager                │
  │  locks WETH / USDC       │ ◀──RELEASE────── │   positions · LTV · health · liquidation · fee │
  └──────────────────────────┘                  │ PToken pMUSD / pMEZO (ERC-4626 + pool)         │
                                                │ OracleRouter (Pyth + Supra)                    │
                                                │ LeverageManager (MUSD loop)                    │
                                                │ SwapLeverageManager (BTC long) ◀─▶ Tigris pool │
          Mezodot agent  ──relay / liquidate──▶ │ KeeperGateway (permissionless)                 │
          (relayer · liquidator · risk · MCP)   └────────────────────────────────────────────────┘
```

## How MUSD, MEZO and BTC are used

| Integration                                                                                                                                                                                                | Where                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Real testnet **MUSD** (`0x1189…c503`) and **MEZO** (`0x7B7c…0001`) are the pool assets                                                                                                                     | `PToken`, `DeployHub.s.sol`                 |
| pMUSD / pMEZO: yield-bearing ERC-4626 receipts, usable as collateral while earning                                                                                                                         | `PToken`, `VaultManager`                    |
| Borrow MUSD **or** MEZO against pTokens, BTC and cross-chain collateral                                                                                                                                    | `VaultManager`                              |
| Mezo's native **BTC** (ERC-20 precompile `0x7b7C…0000`) as plain hub collateral (LTV 70%, liquidation threshold 78%)                                                                                       | `VaultManager`                              |
| **BTC long in one transaction**: a flash swap on Tigris' MUSD/BTC pool buys BTC, posts it, and borrows exactly the MUSD that pays the pool (no flash fee); close sells BTC to repay                        | `SwapLeverageManager`                       |
| 1-click **MUSD loop** via the pool's own ERC-3156 flash loan; the unwind nets debt against the posted pMUSD (`repayWithCollateral`), so it works at any utilisation                                        | `LeverageManager`, `VaultManager`           |
| Mezo's oracle stack: Pyth Core on Mezo (`0x933a…1315`, pushed hourly by Mezo) for MUSD/MEZO/USDC/BTC, keyless Supra DORA proofs for ETH and as a second leg for USDC and BTC; the freshest usable leg wins | `OracleRouter`, `PythSource`, `SupraSource` |
| Mezo's Wormhole Core (chain 50) for cross-chain collateral                                                                                                                                                 | `WormholeAdapter`, `SpokeGateway`           |
| **Mezo Passport** wallets (Unisat, OKX, Xverse via Mezo smart accounts) + EVM wallets                                                                                                                      | `apps/web/src/chain/wagmi.ts`               |
| BTC is the gas token; oracle fees are paid in BTC                                                                                                                                                          | all risk-checked calls                      |

## Repository

```
contracts/          Foundry — hub (Mezo) and spoke contracts, unit/fuzz/invariant/E2E tests, deploy scripts
packages/sdk/       ABIs, deployments, contract-mirroring math, Pyth/Wormhole/payload codecs, on-chain reader
services/agent/     relayer · liquidator · risk engine · MCP server (stdio + HTTP) · Docker
apps/web/           React + wagmi + Mezo Passport dApp
scripts/            ops: deployment check, revenue report, BTC smoke test, ABI and admin-docs checks
scripts/devnet/     two-chain local devnet (anvil hub + spoke) using the production deploy scripts
docs/               DEPLOY.md, RUNBOOK.md, REVENUE.md, SECURITY.md; the original design spec and plan
.github/workflows/  CI on every pull request; nightly testnet, fork and devnet checks
```

## Quickstart (local, two chains, no testnet funds)

Requires Node 22, pnpm 11, Foundry ≥ 1.5, jq.

```bash
pnpm install
git submodule update --init --recursive        # contracts/lib
pnpm devnet                                     # anvil hub :8545 + spoke :8546, deploy + configure + seed

# terminal 2 — agent (anvil #1 as keeper, dev guardian signs VAAs locally)
cd services/agent && MEZODOT_ENV=devnet \
  KEEPER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
  DEVNET_GUARDIAN_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6 \
  pnpm start

# terminal 3 — web app on the devnet
VITE_MEZODOT_ENV=devnet pnpm dev               # http://localhost:3000 (landing page; the app is at #/dashboard)
```

Import an anvil account (e.g. #2 `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a`) into MetaMask with networks `http://127.0.0.1:8545` (chain 31337) and `http://127.0.0.1:8546` (chain 31338). The keys above are Foundry's public test keys — never use them elsewhere.

## Testing

| Suite                  | Command                                                                                         | What it proves                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts (209 tests)  | `pnpm test:contracts`                                                                           | Rate model, ERC-4626 + flash-loan accounting (incl. share-price manipulation), multi-source oracle (freshest leg, per-leg max age, confidence caps, fail-closed cross-check), borrow limits, liquidation, protocol fee and bad-debt write-off, repay with collateral, Wormhole replay/emitter/destination checks and message fees, MUSD loop/unwind, BTC leverage through a Tigris flash swap, **invariants** (pool solvency, hub credit ≤ spoke locked, whole-hub accounting), PRD flows A/B/C across two spokes. `DevWormhole` verifies a **real Mezo-testnet VAA**. |
| Mezo fork (5 tests)    | `MEZO_FORK_RPC=https://rpc.test.mezo.org forge test --root contracts --match-contract ForkMezo` | Hub flows against **live Mezo oracle state**: Pyth push feeds, a real Supra proof unlocking ETH, loop/unwind, borrow and liquidation.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| SDK, agent, web        | `pnpm -r check`                                                                                 | Typecheck, lint, unit tests; TS encoders match Solidity bytes; DSR/walk-forward reference values; MCP tools over the MCP protocol.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Ops scripts (32 tests) | `pnpm check:scripts`, `pnpm check:abis`, `pnpm check:admin-docs`                                | The deployment check and revenue report against fake chains; SDK ABIs equal to the forge build; every `onlyOwner` function listed in SECURITY.md.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deployment check       | `pnpm verify:deployment mezo-testnet`                                                           | The live hub and spokes match their deployment JSON, the SDK ABIs and the documented configuration: code, owners, wiring, 7 collaterals, feeds, Tigris pool, emitters both ways, spoke backing (DEPLOY.md, step 4).                                                                                                                                                                                                                                                                                                                                                    |
| BTC smoke test         | `pnpm smoke:btc --keystore <file> --password-file <file>`                                       | On testnet, with tiny amounts: BTC collateral through the real precompile, a BTC position opened, half closed and closed on the real Tigris pool, every wallet movement checked (DEPLOY.md, step 8).                                                                                                                                                                                                                                                                                                                                                                   |
| Autonomous keeper E2E  | `pnpm devnet:e2e`                                                                               | Spoke deposit → agent relays → borrow (with pull price updates from the agent relay) → ETH drops → **agent liquidates** with a fresh proof → agent relays RELEASE → keeper paid on the spoke.                                                                                                                                                                                                                                                                                                                                                                          |
| Browser E2E            | `pnpm e2e:ui`                                                                                   | Real UI + wallet: supply 10,000 MUSD, post collateral, lock WETH on the spoke, borrow, 3× loop, activity.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

CI (`.github/workflows/ci.yml`) runs `forge fmt --check`, `forge build`, `forge test`, the SDK ABI drift check, `prettier --check`, `pnpm -r check`, the ops-script tests and the admin-docs check on every pull request. `nightly.yml` checks the testnet deployment, runs the Mezo fork tests, deploys a devnet for the keeper E2E and, once enabled, runs the BTC smoke test on testnet.

## PRD flows

- **A — Passive LP:** supply 10,000 MUSD → pMUSD; exchange rate rises with borrower interest.
- **B — Cross-chain borrower:** lock WETH in the Base/Ethereum SpokeGateway → Wormhole DEPOSIT → VaultManager credit → borrow MUSD on Mezo. Withdraw sends a RELEASE back.
- **C — Degen looper:** 1,000 MUSD × 3 → flash 2,000, supply 3,000, borrow 2,001.8 (0.09% fee), repay flash — one transaction. The unwind nets the debt against the posted pMUSD: no second fee.
- **BTC long:** 0.01 BTC at 2× → borrow the MUSD worth 0.01 BTC, buy BTC on Tigris inside the swap callback, post about 0.02 BTC (less the swap fee and price impact); debt = the borrow exactly. Close sells just enough BTC to repay and returns the rest.

## KPIs (from chain / agent)

TVL (idle pool cash + BTC collateral on the hub + spoke collateral, net of borrows), leverage volume (`LeverageManager.Looped` + `SwapLeverageManager.Opened`), agent participation (`KeeperGateway.keeperCount`), cross-chain borrow ratio (agent `/stats`: debt attributed to spoke collateral), protocol revenue (agent `/revenue`, `pnpm revenue:report`).

## Deploying and operating

[`docs/DEPLOY.md`](docs/DEPLOY.md) (deploy, verify, smoke test, redeploy, ownership transfer), [`docs/RUNBOOK.md`](docs/RUNBOOK.md) (incidents), [`docs/REVENUE.md`](docs/REVENUE.md) (revenue reporting and collection). Security model, admin powers and known limitations: [`docs/SECURITY.md`](docs/SECURITY.md).

## Deviations from the original PRD

Spokes run on **Base Sepolia + Ethereum Sepolia** (event-supported chains) instead of Arbitrum. Mezo testnet has Wormhole Core but no automatic relayer/NTT, so messages are delivered by the permissionless Mezodot relayer — or by the user, from the UI ("Relay it yourself"). Contracts verify every VAA, so relayers need no trust.

Oracle: since the Pyth Core cutover (2026-08-26) Hermes needs a paid API key, so the keyless pull model of the original design no longer works. Mezodot reads the Pyth Core contract that Mezo's own pusher refreshes hourly (MUSD, MEZO, USDC, BTC) and takes ETH, plus a second leg for USDC and BTC, from keyless **Supra DORA** proofs, which the agent's `/oracle/update` relay fetches server-side and the transaction verifies on-chain. The browser never calls Hermes and no API key is shipped to it. Details: [`docs/SECURITY.md`](docs/SECURITY.md#oracle-design). The original design spec and plan in `docs/superpowers/` are kept as history.
