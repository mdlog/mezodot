# Security model

**Status: unaudited, testnet only.**

## Trust assumptions

| Component                                     | Trusted for                                                                                                                                       | Not trusted for                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Wormhole guardians                            | Attesting spoke ⇄ hub messages (VAA signatures)                                                                                                   | —                                                                                                 |
| Pyth (Core on Mezo, `0x933a…1315`)            | MUSD, MEZO, USDC prices. Updates are signed by Pyth's routers (3-of-5 since the 2026-08-26 cutover) and verified on-chain                         | Liveness: Mezo's own pusher refreshes these feeds about hourly; the Mezodot agent can too (keyed) |
| Supra DORA (pull contract `0x443A…5702`)      | ETH price and a USDC fallback, from keyless proofs signed by Supra's committee and verified on-chain. Supra's admin can upgrade its pull contract | Freshness: Supra enforces no max age, so the router does (120 s)                                  |
| Owner (deployer, `Ownable2Step`)              | Everything in "Admin powers" below, **including moving user funds**                                                                               | —                                                                                                 |
| Relayers / keepers / the agent's oracle relay | Liveness only: anyone may relay a VAA or attach a signed price proof                                                                              | Safety: every VAA and every price proof is verified on-chain                                      |
| Agent / MCP server                            | Nothing on-chain. Write tools dry-run unless `MCP_ALLOW_WRITE=true`, and over HTTP also need `MCP_TOKEN`                                          | —                                                                                                 |

### Admin powers (testnet: the deployer EOA)

These can move or freeze user funds. A production deployment must put them behind a timelock and multisig, with a guardian role that can only tighten parameters.

| Function                                                                                    | Power                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OracleRouter.setSource` / `setFeed`                                                        | Repoint any price at any source: arbitrary prices allow draining the pools through borrows or seizing healthy positions through liquidation                                             |
| `WormholeAdapter.setSpoke`, `SpokeGateway.setHubEmitter`                                    | Trust a different emitter: forged DEPOSITs credit hub collateral, forged RELEASEs pay out locked spoke tokens. Re-pointing also strands every message in flight (one emitter per chain) |
| `VaultManager.setAdapter` (one-shot), `PToken.setVaultManager`                              | The first (and only) setting decides which contract may credit collateral and open debt                                                                                                 |
| `VaultManager.addCollateral` / `setCollateralParams` / `addMarket`, `SpokeGateway.setToken` | List assets and set LTV, liquidation threshold, bonus and caps (bounded: LT ≤ 95%, LT × (1 + bonus) ≤ 100%); allow tokens and caps on spokes                                            |
| `MezodotPool.withdrawReserves`, `setCaps`                                                   | Withdraw protocol reserves; cap supply and borrows                                                                                                                                      |
| `pause` (VaultManager, PToken, SpokeGateway)                                                | VaultManager: blocks new borrows only (top-ups, repay, withdraw, liquidation stay open). PToken: blocks deposits and borrows. SpokeGateway: blocks new spoke deposits                   |

## Oracle design

`OracleRouter` gives each asset a primary and an optional secondary leg, each with its own max age, plus a per-feed confidence cap:

| Key  | Primary                      | Secondary            | Confidence cap | Cross-check |
| ---- | ---------------------------- | -------------------- | -------------- | ----------- |
| MUSD | Pyth push, 3,900 s           | —                    | 5%             | —           |
| MEZO | Pyth push, 3,900 s           | —                    | 5%             | —           |
| USDC | Pyth push, 3,900 s           | Supra pair 89, 120 s | 2%             | 1.5%        |
| ETH  | Pyth, 120 s (only if pushed) | Supra pair 19, 120 s | 2%             | 1.5%        |

- Strict reads use the primary when it is fresh and confident, else the secondary. When both are usable and published within 60 s of each other they must agree within the divergence limit, or the read reverts.
- **Valuation is conservative:** debt is priced strictly (missing price ⇒ revert); collateral without an acceptable price counts as zero toward borrow and withdraw limits; liquidation prices every held asset strictly, so an outage cannot make a healthy position liquidatable. Debt-free accounts withdraw without any price.
- The 3,900 s max age covers Mezo's hourly push (longest gap since the cutover: 3,668 s). The 5% caps for MUSD/MEZO fit the measured distributions (MUSD conf/price: median 1.22%, p99 2.87%); a 2% cap froze MUSD for hours at a time.

## Key invariants (tested)

- **Pool solvency:** `cash + totalBorrows ≥ totalReserves` (invariant test).
- **Cross-chain backing:** hub credit per (spoke, token) ≤ tokens locked in that SpokeGateway, including while RELEASE messages are in flight (fuzz + invariant tests). Deposits lock before they credit; withdrawals and liquidations debit the hub before the spoke releases.
- **Message binding (payload v2):** every message names its destination (Wormhole chain id + contract). A VAA cannot be executed by a redeployed gateway, another spoke, or a new hub adapter, and each VAA hash is consumed once by the only contract it names. Message type is checked per direction; only the registered emitter per chain is accepted.
- **One-shot adapter:** `setAdapter` cannot be called twice, so the DEPOSIT replay guard (held by the adapter) cannot be reset.
- **Recipients:** withdrawals and remote liquidations only accept left-padded EVM addresses, so released collateral cannot be frozen on a spoke.
- **Flash-loan share price:** `totalAssets` counts the outstanding flash amount, so deposits during a flash loan mint fair shares (a mutation test showed a 10× share gain without it).
- **ERC-4626 inflation:** 6-decimal virtual share offset + seed deposit.
- **Borrow limit:** every new borrow and every collateral withdrawal is checked against Σ value × LTV; liquidation only below HF 1, 50% close factor, `minSeize` guard.
- **Bad debt:** when a liquidation seizes an account's last collateral, the remaining debt is written off: reserves absorb it first, the rest lowers the pToken exchange rate pro rata.

## Known limitations

- **MUSD/MEZO have a single price source** (Pyth, pushed by Mezo). If Mezo's pusher stops for more than ~65 min, borrows, withdrawals with debt and liquidations touching those assets revert until someone pushes (the agent does when given `PYTH_API_KEY`). Within the window, prices can lag by up to the pusher's deviation trigger (1–2%).
- **ETH prices need a proof per transaction.** The web app gets Supra proofs through the agent's `/oracle/update` relay (Supra's endpoint rejects browser CORS). If Supra or the agent is down, WETH counts as $0 toward borrowing, and liquidations of WETH-backed positions wait for a proof.
- **Pull-price choice:** within the 120 s window a caller may pick which valid proof to submit. `SupraSource` keeps only the newest value per pair, so a stored price cannot be rolled back.
- **Relayer liveness:** if no one relays, deposits are not credited and releases are not executed (funds are safe; anyone, including the user from the UI, can relay).
- **Hub account = spoke address:** the depositor's address on the spoke is their hub account. Smart-contract wallets with different addresses per chain should not post cross-chain collateral.
- **Dust collateral defers write-off:** an account left with dust collateral keeps its debt until that dust is liquidated.
- **Compound-style rounding dust:** the aggregate borrow total can retain a few thousand wei after all debts are repaid.
- **MEZO is a Mezo precompile** (`0x7B7c…0001`). Integration assumes standard ERC-20 semantics; forge cannot execute it locally, so the hub is broadcast with `--skip-simulation` (see DEPLOY.md).
