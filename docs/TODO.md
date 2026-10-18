# Mezodot — status

Implemented (see README):

- [x] Contracts: PToken (ERC-4626 + MezodotPool), InterestRateModel, OracleRouter (Pyth Core push + Supra pull, freshest usable leg, fail-closed cross-check), VaultManager (share, plain BTC and remote collateral, `repayWithCollateral`, protocol share of liquidation bonuses), WormholeAdapter, SpokeGateway (deferred releases), LeverageManager (flash-loan loop, netted unwind), SwapLeverageManager (BTC long through a Tigris flash swap), KeeperGateway
- [x] Tests: unit, fuzz, invariant (pool, cross-chain, whole hub), PRD E2E (two spokes), real-VAA parity, Mezo fork
- [x] Deploy scripts (hub, spokes, cross-chain configure, leverage-manager replacement, pause) and a two-chain local devnet
- [x] Testnet deployment: Mezo hub + Base Sepolia + Ethereum Sepolia spokes, linked both ways (deployment JSON in `packages/sdk/src/deployments`), checked with `pnpm verify:deployment`
- [x] SDK, agent (relayer, liquidator incl. sales of seized BTC, risk engine, revenue tracking, MCP stdio + HTTP, Docker)
- [x] Web app on-chain with Mezo Passport: markets, borrow, cross-chain, BTC leverage desk, MUSD loop, revenue view
- [x] Autonomous keeper E2E and browser E2E
- [x] CI on every pull request (contracts, SDK ABI drift, formatting, packages, ops scripts, admin-powers docs) and nightly testnet, fork and devnet checks
- [x] Operations: deployment check, revenue report with collection plan, BTC smoke test; DEPLOY, RUNBOOK, REVENUE and SECURITY docs

Next:

- [ ] Host the agent (HTTPS; the web app needs its `/oracle/update` relay) and web app; record the 2-minute demo
- [ ] MUSD/MEZO price liveness: a Pyth key entitled to MUSD and MEZO (today's key covers ETH and BTC only), or coverage agreed with Mezo; the agent should check entitlement at startup and alert when a push feed nears expiry with no pusher able to refresh it
- [ ] Owner key: move the deployer keystore out of the repository and drop its password file (DEPLOY.md, key storage); then a hardware wallet or multisig
- [ ] Deploy scripts: write the deployment JSON only on a confirmed broadcast (`vm.isContext(ScriptBroadcast)`), record the owner and an ABI/version hash in it; exclude `.secrets/` and `.worktrees/` from the Docker build context
- [ ] Verify contract sources on the explorers (Blockscout on Mezo, Etherscan on the Sepolia chains)
- [ ] External audit; timelock + multisig ownership, with a guardian role that can only tighten parameters
- [ ] pToken integrations with Mezo DEX pools (pMUSD/MUSD liquidity)
