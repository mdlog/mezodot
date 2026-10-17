# Security model

**Status: unaudited, testnet only.**

## Trust assumptions

| Component                        | Trusted for                                                                    | Not trusted for                                           |
| -------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Wormhole guardians               | Attesting spoke/hub messages (VAA signatures)                                  | —                                                         |
| Pyth                             | Prices (staleness ≤ 120 s, confidence ≤ 2%)                                    | —                                                         |
| Owner (deployer, `Ownable2Step`) | Risk parameters, caps, pausing, listing collateral/markets, reserve withdrawal | Moving user funds (no such function)                      |
| Relayers / keepers               | Liveness only                                                                  | Safety — every VAA is verified on-chain, anyone may relay |
| Agent / MCP server               | Nothing on-chain; write tools are dry-run unless `MCP_ALLOW_WRITE=true`        | —                                                         |

## Key invariants (tested)

- **Pool solvency:** `cash + totalBorrows ≥ totalReserves` (invariant test).
- **Cross-chain backing:** hub credit per (spoke, token) ≤ tokens locked in that SpokeGateway, including while RELEASE messages are in flight (fuzz + invariant tests). Deposits lock before they credit; withdrawals and liquidations debit the hub before the spoke releases.
- **Replay / spoofing:** each VAA hash is consumed once; only the registered emitter for a given Wormhole chain is accepted; message type is checked per direction.
- **Flash-loan share price:** `totalAssets` counts the outstanding flash amount, so deposits during a flash loan mint fair shares (a mutation test showed a 10× share gain without it).
- **ERC-4626 inflation:** 6-decimal virtual share offset + seed deposit.
- **Borrow limit:** every new borrow and every collateral withdrawal is checked against Σ value × LTV with fresh prices; liquidation only below HF 1, 50% close factor, `minSeize` guard.

## Known limitations

- **Bad debt** is not socialised; if collateral is exhausted the residual debt stays on the account and is covered by reserves manually.
- **Oracle liveness:** risk-checked actions need fresh Pyth prices posted in the same transaction; MEZO and ETH are pull-only feeds on Mezo. Views return 0 for feeds that were never pushed.
- **Relayer liveness:** if no one relays, deposits are not credited and releases are not executed (funds are safe; anyone, including the user from the UI, can relay).
- **Hub account = spoke address:** the depositor's address on the spoke is their hub account. Smart-contract wallets with different addresses per chain should not post cross-chain collateral.
- **Compound-style rounding dust:** the aggregate borrow total can retain a few thousand wei after all debts are repaid.
- **Admin power** is significant on testnet (parameters, pausing). A production deployment should place ownership behind a timelock and multisig.
- MEZO token on testnet is a Mezo precompile (`0x7B7c…0001`); integration assumes standard ERC-20 semantics.
