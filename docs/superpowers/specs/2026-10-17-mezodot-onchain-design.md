# Mezodot Protocol — On-chain Design Spec

> **Historical document (2026-10-17).** Kept as the record of the original design; where it differs from the code, the code wins. Since then the oracle moved from Hermes pulls on Pyth `0x2880…` to Pyth Core `0x933a…1315` pushed by Mezo plus keyless Supra proofs, and BTC collateral, BTC leverage through Tigris, the netted unwind, protocol revenue and the ops tooling were added. Current documentation: [README](../../../README.md), [DEPLOY](../../DEPLOY.md), [SECURITY](../../SECURITY.md), [RUNBOOK](../../RUNBOOK.md), [REVENUE](../../REVENUE.md).

Date: 2026-10-17 · Status: approved in brainstorming (sections 1–3 approved in chat; section 4 approved via "lanjutkan semua")
Target: Mezo Buildathon, Track 1, **Wave 1 (deadline 2026-10-26)** — all four subsystems.
Out of scope for this spec: running the actual testnet deployment (scripts are prepared, executed later), pitch deck, video.

## 0. Intent

Turn the current simulated Mezodot frontend into a working dApp that implements the PRD: an omnichain money market on Mezo where MUSD/MEZO are supplied into ERC-4626 pTokens, borrowed against local or cross-chain collateral, looped in one transaction, and kept safe by permissionless AI/keeper agents.

Success criteria:

- Every PRD user flow (A: LP 10,000 MUSD → pMUSD, B: cross-chain borrower, C: 1,000 MUSD loop 3×) works end-to-end on a local two-chain devnet, with tests proving it.
- Contracts are deployable to Mezo testnet + Base Sepolia + Ethereum Sepolia with one documented command sequence.
- The frontend shows only on-chain/oracle data; nothing is labelled "simulated" anymore.
- Judging criteria alignment: deep MUSD/MEZO integration (real testnet MUSD/MEZO, Pyth feeds, Mezo Passport), composable ERC-4626 receipts, tested and secure code.

### Deviations from the PRD (deliberate)

| PRD                                                   | This spec                                                     | Why                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Spoke on Arbitrum                                     | Spokes on **Base Sepolia + Ethereum Sepolia**                 | Event lists only Mezo/Ethereum/Base/BNB as supported chains                                                       |
| Wormhole NTT / relayer                                | Wormhole **Core messaging + permissionless self-run relayer** | No Wormhole Relayer/NTT/Executor deployed on Mezo testnet; Core is (`0x268557122Ffd64c85750d630b716471118F323c8`) |
| KeeperGateway "access-controlled or incentive-driven" | Incentive-driven, permissionless                              | Stronger decentralisation story; no keeper whitelist to manage                                                    |

## 1. Facts this design relies on (verified 2026-10-17)

| Item                       | Value                                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Mezo testnet chainId / RPC | `31611` / `https://rpc.test.mezo.org`, gas token BTC (18 dec)                                                                                   |
| MUSD (testnet)             | `0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503` (18 dec)                                                                                           |
| MEZO (testnet)             | `0x7B7c000000000000000000000000000000000001`                                                                                                    |
| Pyth on Mezo               | `0x2880aB155794e7179c9eE2e38200202908C17B43` (pull updates accepted)                                                                            |
| Pyth feed ids              | MUSD/USD `0x0617a9b7…c6de`, MEZO/USD `0x80beaaed…26df`, ETH/USD `0xff61491a…0ace`, USDC/USD `0xeaa020c6…c94a`                                   |
| Wormhole chain ids         | Mezo `50`, Ethereum Sepolia `10002`, Base Sepolia `10004`                                                                                       |
| Wormhole Core              | Mezo testnet `0x2685…23c8`, Base Sepolia `0x79A1027a6A159502049F10906D333EC57E95F083`, Eth Sepolia `0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78` |
| Wallet                     | `@mezo-org/passport` (RainbowKit-based, BTC wallets), viem 2.x                                                                                  |

All addresses live in `packages/sdk/src/deployments/*.json` and env, never hard-coded in contracts.

## 2. Repository layout

```
contracts/        Foundry: src/hub, src/spoke, src/libraries, test/, script/
packages/sdk/     ABIs (generated from Foundry out/), deployments, shared math, Pyth + Wormholescan helpers
apps/web/         existing Vite/React UI, now on-chain via wagmi + Mezo Passport
services/agent/   relayer, liquidator, risk engine, MCP server (Node 22, TypeScript)
scripts/devnet/   two-anvil local devnet (hub + spoke) with dev Wormhole + MockPyth
docs/             specs, plans, deploy runbook, security notes
```

pnpm workspace at the root; `pnpm check` runs everything (forge test, tsc, eslint, vitest).

## 3. Contracts

### 3.1 Hub (Mezo)

**`MezodotPool` (abstract) + `PToken` (ERC-4626)** — one per asset (pMUSD, pMEZO). The vault _is_ the lending pool.

- `totalAssets = cash + totalBorrows − totalReserves`; exchange rate grows from borrower interest.
- Compound-style `borrowIndex`, per-second accrual in `accrueInterest()` before every state change. Debt rounds up, shares round in protocol favour.
- Kinked IRM (`InterestRateModel`, immutable per pool):

  | Pool | Base | Slope 1 | Kink | Slope 2 | Reserve factor |
  | ---- | ---- | ------- | ---- | ------- | -------------- |
  | MUSD | 0%   | 6%      | 80%  | 80%     | 10%            |
  | MEZO | 2%   | 8%      | 70%  | 100%    | 10%            |

- Supply rate = borrowRate × util × (1 − RF).
- ERC-4626 inflation defence: `_decimalsOffset() = 6` + seed deposit in deploy script.
- ERC-3156 flash loan from cash, fee 9 bps → reserves.
- `borrow/repay` callable only by `VaultManager` (debt is owned by VaultManager accounts).
- Admin: supply cap, borrow cap, reserve withdrawal (`Ownable2Step`), pause (blocks deposit/borrow only).

**`VaultManager`** — source of truth for positions.

- Collateral registry `collateralId → {kind: LOCAL|REMOTE, token, wormholeChain, decimals, priceId, ltv, lt, bonus, cap}`.
- Initial params:

  | Collateral | Where              | LTV | LT  | Bonus |
  | ---------- | ------------------ | --- | --- | ----- |
  | pMUSD      | Hub                | 80% | 85% | 5%    |
  | pMEZO      | Hub                | 50% | 60% | 10%   |
  | WETH       | Base / Eth Sepolia | 75% | 80% | 7%    |
  | USDC       | Base / Eth Sepolia | 80% | 85% | 5%    |

- Borrowable assets: MUSD, MEZO.
- `HF = Σ(value × LT) / Σ debt`; borrow / withdraw require `Σ(value × LTV) ≥ debt` afterwards. pToken collateral valued at `convertToAssets × underlying price`.
- Local pToken collateral is escrowed in VaultManager (keeps accruing yield).
- Operator delegation `setOperator(op, bool)` so LeverageManager can act for a user.
- Liquidation when HF < 1, close factor 50%, `seize = repay × (1 + bonus) / collateralPrice`, `minSeize` slippage guard. Local seize → pTokens to liquidator. Remote seize → balance debited, `RELEASE` to the liquidator's address on the spoke.
- `getRiskSnapshot(account)` view: per-collateral value, debts, HF, borrow capacity.

**`OracleRouter`** — Pyth `getPriceNoOlderThan(id, 120s)`, rejects `conf/price > 2%`, normalises to WAD. Risk-checked entrypoints are `payable` and take `bytes[] priceUpdate`; the router pays Pyth's fee and the caller gets the remaining BTC refunded.

**`WormholeAdapter`** — the only contract talking to Wormhole on the hub.

- Payload `abi.encodePacked(uint8 version, uint8 type, uint64 nonce, bytes32 account, bytes32 token, uint256 amount)`; types `DEPOSIT` (spoke→hub), `RELEASE` (hub→spoke).
- Receive: `parseAndVerifyVM` → emitter must be the registered spoke for `vm.emitterChainId` → `consumed[vm.hash]` replay guard → map `(chain, token)` → collateralId → `VaultManager.creditRemote`.
- Send: `publishMessage{value: messageFee}` with configurable consistency level.
- **Invariant:** hub remote credit per (spoke, token) ≤ tokens locked in that spoke (deposits credit only after lock; releases debit hub before unlock).

**`LeverageManager`** — `loop(principal, leverage, minCollateralShares, priceUpdate)`:
pull principal → flash borrow `principal × (L−1)` → deposit all into pMUSD → `depositCollateralFor(user)` → `borrowFor(user, debt + fee)` → repay flash → VaultManager enforces LTV.
`unwind(maxRepay, priceUpdate)`: flash borrow user debt → `repayFor` → withdraw collateral → redeem → repay flash → equity to user.

**`KeeperGateway`** — permissionless agent surface: `triggerLiquidation(...)`, `relayMessage(vaa)`, `getRiskSnapshot(user)`; records unique keeper addresses and counts (KPI "Agent Participation").

### 3.2 Spoke (Base Sepolia, Ethereum Sepolia)

**`SpokeGateway`** — allowlisted tokens (WETH, USDC); `deposit(token, amount)` locks via `SafeERC20` and publishes `DEPOSIT`; `receiveMessage(vaa)` accepts `RELEASE` only from the registered hub adapter emitter (chain 50), with replay guard, then transfers. Per-token deposit cap, pause on deposits only.

### 3.3 Security baseline

`ReentrancyGuard` on all mutating paths, CEI ordering, `SafeERC20`, `Ownable2Step` admin, caps, slippage guards, no upgradeability. Documented limitations: bad debt not socialised (absorbed by reserves manually), trusted admin on testnet, unaudited, relayer liveness needed for cross-chain UX (not safety).

## 4. Agent layer (`services/agent`)

One Node process, modules toggled by env, shipped with Dockerfile + `docker-compose.yml`.

1. **Relayer** — watches `LogMessagePublished` from spoke gateways and the hub adapter, fetches signed VAAs from Wormholescan testnet (`/v1/signed_vaa/{chain}/{emitter}/{seq}`) with backoff (devnet: signs with the dev guardian key), submits to `KeeperGateway.relayMessage` / `SpokeGateway.receiveMessage`. Idempotent (`isConsumed` check, persisted cursor).
2. **Liquidator** — indexes borrowers from VaultManager events, computes HF with Hermes prices, picks the most profitable pair, repays 50%, simulates with `eth_call`, sends with `priceUpdate` + `minSeize`. Uses its own MUSD/MEZO inventory.
3. **Risk engine** — Pyth Benchmarks history for ETH, MEZO, MUSD, USDC: annualised volatility (30/90d), max drawdown, 1h VaR99, recommended LTV/LT (P(drop beyond LT−LTV buffer within 1h) < 1%), walk-forward over leverage grid {1.5…4} with in-sample selection / out-of-sample Sharpe, Deflated Sharpe Ratio (Bailey & López de Prado). Output JSON report + read-only HTTP endpoint. Recommendations are advisory, never written on-chain automatically.
4. **MCP server** (`@modelcontextprotocol/sdk`, stdio + Streamable HTTP): read tools `get_markets`, `get_position`, `get_risk_report`, `simulate_loop`, `simulate_borrow`, `list_liquidatable`, `list_pending_messages`; write tools `trigger_liquidation`, `relay_message` default to dry-run and only execute with `MCP_ALLOW_WRITE=true` and a keeper key.

## 5. Frontend (`apps/web`)

- wagmi 2 + viem 2 + `@mezo-org/passport` + RainbowKit + TanStack Query. Chains: Mezo testnet, Base Sepolia, Eth Sepolia, plus devnet hub/spoke.
- Reads: pool/vault views via multicall, `getRiskSnapshot`, Pyth Hermes prices for previews. Writes: approve → action with tx state toasts and explorer links; price updates fetched from Hermes and fee read from Pyth before each risk-checked call.
- Cross-chain page shows the real message lifecycle: spoke tx → Wormhole sequence → VAA signed (Wormholescan poll) → relayed (hub event) → credited.
- Agents page reads the risk report endpoint and KeeperGateway stats; Activity reads the user's on-chain events.
- Shared math (`packages/sdk/math`) mirrors contract formulas for previews, checked against Solidity test vectors.
- If a chain has no deployment configured, the UI says so explicitly instead of showing numbers. The existing visual design is kept.

## 6. Testing

- **Foundry:** unit tests per contract; fuzz tests (interest accrual, share/asset conversions, liquidation maths); invariant tests (pool solvency `cash + borrows ≥ reserves`, Σ user debt ≈ totalBorrows, remote credit ≤ spoke locked); end-to-end tests for PRD flows A, B, C with `MockPyth` and a dev Wormhole implementation that verifies real VAA encoding signed by a dev guardian key.
- **Optional fork test** against Mezo testnet RPC (real MUSD, Pyth) when `MEZO_RPC` is set.
- **Agent:** Vitest for risk maths (reference values), relayer with mocked API, liquidation profitability; devnet e2e: deposit on spoke → relay → borrow → price drop → liquidation → release on spoke.
- **Web:** typecheck, lint, unit tests for hooks/math, build; Playwright smoke against devnet.

## 7. Deployment (prepared, not executed)

`forge script` `DeployHub`, `DeploySpoke`, `ConfigureCrossChain` (register emitters both ways) driven by env; each writes `packages/sdk/src/deployments/<chain>.json`. `docs/DEPLOY.md` runbook: faucet → deploy hub → deploy spokes → configure → seed deposits → start agent → build web. Local equivalent: `pnpm devnet`.
