# Mezodot — status

Implemented (see README and docs/superpowers/plans/2026-10-17-mezodot-onchain.md):

- [x] Contracts: PToken (ERC-4626 + MezodotPool), InterestRateModel, OracleRouter (Pyth Core push + Supra pull), VaultManager, WormholeAdapter, SpokeGateway, LeverageManager, KeeperGateway
- [x] Tests: unit, fuzz, invariant, PRD E2E (two spokes), real-VAA parity
- [x] Deploy scripts (hub, spokes, cross-chain configure) and a two-chain local devnet
- [x] SDK, agent (relayer, liquidator, risk engine, MCP stdio + HTTP, Docker)
- [x] Web app on-chain with Mezo Passport
- [x] Autonomous keeper E2E and browser E2E

Next:

- [ ] Run docs/DEPLOY.md on Mezo testnet + Base Sepolia + Ethereum Sepolia; commit deployment JSON
- [ ] Host the agent (HTTPS; the web app needs its `/oracle/update` relay) and web app; record the 2-minute demo
- [ ] Optional: Pyth API key for the agent's pusher (ETH Pyth leg, MUSD/MEZO self-heal); ask Mezo to push ETH/USD
- [ ] External audit; timelock + multisig ownership
- [ ] pToken integrations with Mezo DEX pools (pMUSD/MUSD liquidity)
