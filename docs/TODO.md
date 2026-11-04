# Mezodot — status

Implemented (see README):

- [x] Contracts: PToken (ERC-4626 + MezodotPool), InterestRateModel, OracleRouter (Skip, Pyth Core push, Supra pull and a Tigris TWAP fallback, freshest usable leg, fail-closed cross-check), VaultManager (share, plain BTC and remote collateral, `repayWithCollateral`, protocol share of liquidation bonuses), WormholeAdapter, SpokeGateway (deferred releases), LeverageManager (flash-loan loop, netted unwind), SwapLeverageManager (BTC long through a Tigris flash swap), TroveRouter (BTC to a Mezo trove to pMUSD), KeeperGateway
- [x] Tests: unit, fuzz, invariant (pool, cross-chain, whole hub), PRD E2E (two spokes), real-VAA parity, Mezo fork
- [x] Deploy scripts (hub, spokes, cross-chain configure that refuses to re-point a link backing funds, BTC leverage-manager and keeper-gateway replacement, pause) and a two-chain local devnet
- [x] Testnet deployment: Mezo hub + Base Sepolia + Ethereum Sepolia spokes, linked both ways (deployment JSON in `packages/sdk/src/deployments`), checked with `pnpm verify:deployment`
- [x] SDK, agent (relayer, liquidator incl. sales of seized BTC, risk engine, revenue tracking, MCP stdio + HTTP, Docker)
- [x] Web app on-chain with Mezo Passport: markets, borrow, BTC trove, cross-chain, BTC leverage desk, MUSD loop, revenue view, on-chain proof
- [x] Autonomous keeper E2E and browser E2E
- [x] CI on every pull request (contracts, SDK ABI drift, formatting, packages, ops scripts, admin-powers docs) and nightly testnet, fork and devnet checks
- [x] Operations: deployment check, revenue report with collection plan, BTC smoke test; DEPLOY, RUNBOOK, REVENUE and SECURITY docs
- [x] Exercised on testnet: pMEZO collateral, MEZO borrowing, keeper liquidation, a Mezo trove through TroveRouter, stable pMUSD/MUSD pool ([EVIDENCE.md](EVIDENCE.md))
- [x] Source verification: all 17 live contracts are exact matches on Sourcify, all 15 hub contracts are verified on Mezo's explorer, and both spoke gateways are verified on Blockscout (Base Sepolia, Ethereum Sepolia) (DEPLOY.md, step 4)

Next:

- [x] Record the Wave 2 demo ([video/README.md](../video/README.md)); not uploaded yet
- [x] Run the trove page on testnet: filmed for the demo, signing through the pipeline's injected wallet
- [ ] Try the trove page with a wallet extension such as MetaMask
- [ ] Outside testers ([TESTING.md](TESTING.md))
- [ ] MEZO price liveness: its TWAP fallback returns no price until the MEZO/MUSD pool trades near the oracle (it needs about 800 more MEZO sold into it), or coverage agreed with Mezo. MUSD's fallback works
- [ ] Pyth key: the agent's key is entitled to no feed today (HTTP 403 for all five), so its pusher does nothing. BTC no longer needs it; ETH rests on Supra until it is fixed or dropped
- [ ] Owner key: move the deployer keystore out of the repository and drop its password file (DEPLOY.md, key storage); then a hardware wallet or multisig
- [ ] Deploy scripts: write the deployment JSON only once the broadcast is mined (a dry run no longer writes it, but a broadcast still writes it during forge's local run), and record the owner and an ABI/version hash in it
- [ ] Nightly devnet keeper E2E: red since 2026-10-20 because the devnet hub priced gas so high that every liquidation looked unprofitable. The fix is in `scripts/devnet/start.sh`; confirm the next nightly run passes
- [ ] Oracle: close the residual price pick window on USDC's Pyth leg and the MUSD and MEZO legs (3,900 s; SECURITY.md, price pick window), e.g. a short max age for the prices liquidations read
- [ ] External audit; timelock + multisig ownership, with a guardian role that can only tighten parameters
- [ ] Deepen pMUSD/MUSD liquidity (40 of each today) and look at a gauge; the agent could use the pool when pMUSD has no idle cash
- [ ] Host the web app as a static build: the live demo is a Vite dev server, which is slow on first load
