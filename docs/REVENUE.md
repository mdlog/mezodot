# Protocol revenue

Mezodot earns from three sources and keeps the proceeds in two places: **pool reserves** (inside each `PToken`) and the **treasury's collateral** (inside `VaultManager` custody). The owner and the treasury are both the deployer `0x08Aa…7EDA` on testnet. This page covers how each source accrues, where it sits, how to report it and how to collect it. The admin powers behind these settings are listed in [SECURITY.md](SECURITY.md#admin-powers-testnet-the-deployer-eoa).

| Source          | Rate (deployed / bound)                      | Set with                               | Accrues to                                     | Event                                                |
| --------------- | -------------------------------------------- | -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Reserve factor  | 10% of borrower interest / ≤ 30%             | `MezodotPool.setReserveFactor` (WAD)   | The pool's `totalReserves`, in its asset       | `InterestAccrued` (running reserves total)           |
| Flash-loan fee  | 0.09% of each flash loan, rounded up / fixed | `FLASH_FEE_BPS = 9` (constant)         | The pool's `totalReserves`                     | `FlashLoan(receiver, amount, fee)`                   |
| Liquidation fee | 10% of each liquidation bonus / ≤ 50%        | `VaultManager.setLiquidationFee` (bps) | Treasury's collateral balance, in seized units | `LiquidationFeeTaken(account, id, amount, treasury)` |

## How each source accrues

**Reserve factor.** Every `accrueInterest` (each pool action) adds `interest × reserveFactor` to `totalReserves`. Reserves are excluded from what suppliers own (`totalAssets = cash + flash loan outstanding + totalBorrows − totalReserves`), so suppliers earn `borrow rate × utilisation × (1 − reserve factor)`. `setReserveFactor` accrues first: interest earned before the change keeps the old split. Example: 1 M MUSD borrowed at 50% utilisation pays 3.75% a year (MUSD curve: 6% at the 80% kink), so 37,500 MUSD of interest, of which 3,750 MUSD go to reserves.

**Flash-loan fee.** `MezodotPool.flashLoan` (ERC-3156, open to anyone while the pool is not paused) charges 0.09% (rounded up) and adds it to `totalReserves` when the loan is repaid. The main user is the MUSD loop: `LeverageManager.loop` flash-borrows the extra exposure (a 1,000 MUSD loop at 3× borrows 2,000 and pays 1.8 MUSD). The loop's unwind nets the debt against the posted pMUSD and pays no second fee, and BTC leverage (`SwapLeverageManager`) uses a Tigris flash swap, which pays Tigris' swap fee and no Mezodot fee.

**Liquidation fee.** A liquidation seizes the repaid value plus the collateral's bonus (5% for pMUSD, BTC and USDC, 7% for WETH, 10% for pMEZO). The protocol keeps `liquidationFeeBps` of the bonus part:

```
protocolFee = seized × bonus / (1 + bonus) × liquidationFeeBps / 10,000
```

Repaying $100 of debt against BTC (5% bonus) seizes $105 of BTC: the bonus is $5, the protocol keeps $0.50 and the liquidator receives $104.50. The liquidator's `minSeize` applies to its own share. The fee is credited as `collateralBalance[treasury][collateralId]` without moving any token (no transfer, no spoke message).

Losses come out of reserves first: when a liquidation takes an account's last collateral, the remaining debt is written off against `totalReserves` before suppliers' exchange rate absorbs the rest (`BadDebtWrittenOff(account, amount, fromReserves)` on the pool).

## Where it sits

- **Reserves** are an accounting claim on the pool, not segregated cash. `withdrawReserves(amount, to)` accrues interest and then requires `amount ≤ totalReserves` and `amount ≤ cash`; at high utilisation it reverts with `InsufficientCash` until borrowers repay or suppliers deposit.
- **Liquidation fees** are the treasury account's collateral in `VaultManager`, in the units of the seized collateral: pMUSD/pMEZO shares (they keep earning supply interest), BTC (native BTC held by `VaultManager`), or WETH/USDC on a spoke (the hub holds the claim, the tokens stay locked in that chain's `SpokeGateway`). They count as the treasury's position: if the treasury account ever borrowed, they would back that debt.
- `setTreasury(new)` redirects future fees only; balances already credited stay with the old account until it withdraws them.

## Reporting

**`pnpm revenue:report [mezo-testnet | devnet-hub] [--json] [--no-events] [--from-block <n>] [--to <address>]`** (read-only, no agent needed) reads the hub at its latest block and prints:

- per pool: reserve factor, reserves stored and accrued to that block (exactly as the contract computes them), idle cash and what `withdrawReserves` can take now, and lifetime flash fees, reserve withdrawals and bad debt absorbed (events since the deployment's start block);
- per collateral: what the treasury holds in custody (shares also in their asset) with a USD value at the last oracle price, and lifetime fees taken;
- totals, and a **collection plan**: the exact `cast send` commands that would collect what is collectable now, marked with the key that signs each one. Nothing is sent.

Use `--json` for bookkeeping (amounts as integer strings in token units). Keep the JSON of each collection run with the transaction hashes.

The agent tracks the same figures continuously: `GET /revenue` (event totals scanned incrementally), the revenue fields of `GET /stats`, and the "Protocol revenue" panel of the web app's Overview. For alerts, watch `LiquidationFeeTaken`, `FlashLoan`, `ReservesWithdrawn` and `BadDebtWrittenOff`, and the governance events `ReserveFactorSet`, `LiquidationFeeSet` and `TreasurySet`.

## Collecting

Run `pnpm revenue:report` and follow its collection plan, or the steps below. Owner and treasury sign with their keystores ([DEPLOY.md, key storage](DEPLOY.md#key-storage)); `RPC` is the Mezo RPC URL.

```bash
RPC=https://rpc.test.mezo.org
KEYSTORE=~/.mezodot/keystores/deployer
D=packages/sdk/src/deployments/mezo-testnet.json
VM=$(jq -r .contracts.vaultManager $D); PMUSD=$(jq -r .contracts.pMUSD $D); ADAPTER=$(jq -r .contracts.wormholeAdapter $D)
TREASURY=$(cast call $VM "treasury()(address)" --rpc-url $RPC)
```

1. **Reserves** (owner), at most the report's "withdrawable now":

   ```bash
   cast send $PMUSD "withdrawReserves(uint256,address)" <amount> <to> --rpc-url $RPC --keystore $KEYSTORE
   ```

2. **Treasury collateral on the hub** (treasury): BTC and pTokens. With no debt on the treasury account no price update is needed (`"[]"`).

   ```bash
   cast send $VM "withdrawCollateral(uint256,uint256,address,bytes[])" <collateralId> <amount> $TREASURY "[]" --rpc-url $RPC --keystore $KEYSTORE
   # pTokens: redeem for MUSD/MEZO, as far as the pool's idle cash allows (or keep the shares earning)
   cast send $PMUSD "redeem(uint256,address,address)" <shares> <to> $TREASURY --rpc-url $RPC --keystore $KEYSTORE
   ```

   BTC arrives as native BTC in the recipient's balance.

3. **Treasury collateral on a spoke** (treasury): WETH and USDC leave through a RELEASE to the same address on the spoke. `msg.value` pays the hub's Wormhole fee (0 on Mezo testnet today); any excess is refunded.

   ```bash
   FEE=$(cast call $ADAPTER "messageFee()(uint256)" --rpc-url $RPC | cut -d' ' -f1)
   cast send $VM "withdrawRemote(uint256,uint256,bytes32,bytes[])" <collateralId> <amount> $(cast abi-encode "f(address)" <recipient>) "[]" --value $FEE --rpc-url $RPC --keystore $KEYSTORE
   ```

   The agent relays the RELEASE to the spoke (Mezo is final at inclusion; a release reached the spoke within a minute in testing). Relay it by hand if needed ([RUNBOOK.md, section 3](RUNBOOK.md#3-bridge-or-guardian-incident)).

4. **Record**: run `pnpm revenue:report --json` again and keep both reports with the transaction hashes.

Before a redeploy, collect from the old deployment while the deployment JSON still names it ([DEPLOY.md, Redeploy](DEPLOY.md#9-redeploy)).

## Changing the parameters

`setReserveFactor` (per pool, ≤ 30%), `setLiquidationFee` (≤ 50% of the bonus) and `setTreasury` are owner calls with immediate effect. A production deployment should put them behind a timelock and a multisig. Check the live values with `pnpm verify:deployment` (`LIQUIDATION_FEE_BPS` and `EXPECTED_TREASURY` are compared when set).
