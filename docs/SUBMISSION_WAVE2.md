# Wave 2 submission text

The text for the Mezo Buildathon form on AKINDO. The form has no track field, so the track goes in the updates.

**Links**

- App: <https://mezodot.mdloglabs.org>
- Proof: <https://mezodot.mdloglabs.org/#/proof>
- Deck: <https://github.com/mdlog/mezodot/blob/main/docs/deck/DECK.pdf>
- Evidence: <https://github.com/mdlog/mezodot/blob/main/docs/EVIDENCE.md>
- Code: <https://github.com/mdlog/mezodot>
- Video: to be added

## Updates since Wave 1

**Track 1, DeFi. Status: live on Mezo testnet, not audited. Team: MDLOG Labs.**

Mezodot is a money market for MUSD and MEZO on Mezo. Wave 2 acted on the Wave 1 feedback:

- **Every missing path now runs on testnet.** pMEZO as collateral, MEZO borrowing, and keeper liquidation by the agent, with each transaction listed in the app at `#/proof`. The liquidation was staged: the owner lowered pMEZO's limits for about 8 minutes, and the agent found and liquidated the position unprompted. The evidence page says so.
- **New MUSD utility: `TroveRouter`.** BTC opens a Mezo trove through `BorrowerOperationsSignatures` and its MUSD goes into pMUSD, in one transaction. Supply can later repay or close the trove. It handles Mezo's fee, gas compensation, minimum debt, Recovery Mode and redemption surplus. It is deployed and passes against Mezo's real contracts on a fork. A testnet run is pending.
- **Price liveness.** BTC now reads Mezo's own Skip feed first, with no key. A Tigris TWAP sits behind MUSD and MEZO. It only serves when Mezo's Pyth push is stale, and only inside a band around the last push. MUSD's fallback works today. MEZO's returns no price until its testnet pool trades near the oracle.
- **pMUSD/MUSD liquidity.** A stable Tigris pool, seeded with about 40 of each.
- **Verification.** All 15 hub contracts are now verified on Mezo's explorer, and exact matches on Sourcify.
- **Materials.** A deck, a proof page, a tester guide and a dated roadmap.

**Who pays:** borrowers (10% of interest goes to the protocol), flash borrowers (0.09%) and liquidated accounts (10% of the liquidation bonus). Earnings so far are test amounts: $0.06.

**What is not done:** no outside users yet, no audit, one owner key on testnet, and the live demo is a dev server. A trove costs 1% a year and pMUSD pays 0.03% today, so minting to supply only pays above about 39% utilisation. The Wave 1 milestones for a timelock, a multisig and static hosting moved to December. veMEZO and gauges were left out of this wave.

## Roadmap for the form

- **By 12 November 2026:** a trove run on testnet, outside testers, a new demo video.
- **December 2026:** static build, timelock and multisig, MEZO price fallback in service.
- **First quarter of 2027:** external audit, then mainnet with capped markets.
