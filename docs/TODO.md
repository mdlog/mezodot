# Mezodot — status

Implemented (see README and docs/superpowers/plans/2026-10-17-mezodot-onchain.md):

- [x] Contracts: PToken (ERC-4626 + MezodotPool), InterestRateModel, OracleRouter (Pyth), VaultManager, WormholeAdapter, SpokeGateway, LeverageManager, KeeperGateway
- [x] Tests: unit, fuzz, invariant, PRD E2E (two spokes), real-VAA parity
- [x] Deploy scripts (hub, spokes, cross-chain configure) and a two-chain local devnet
- [x] SDK, agent (relayer, liquidator, risk engine, MCP stdio + HTTP, Docker)
- [x] Web app on-chain with Mezo Passport
- [x] Autonomous keeper E2E and browser E2E

Next:

- [ ] Run docs/DEPLOY.md on Mezo testnet + Base Sepolia + Ethereum Sepolia; commit deployment JSON
- [ ] Host the agent and web app; record the 2-minute demo
- [ ] External audit; timelock + multisig ownership
- [ ] pToken integrations with Mezo DEX pools (pMUSD/MUSD liquidity)
