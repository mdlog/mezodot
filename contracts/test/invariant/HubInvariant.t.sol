// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MessageFeeFixture} from "../utils/MessageFeeFixture.sol";
import {PToken} from "../../src/hub/PToken.sol";
import {VaultManager} from "../../src/hub/VaultManager.sol";
import {LeverageManager} from "../../src/hub/LeverageManager.sol";
import {SwapLeverageManager} from "../../src/hub/SwapLeverageManager.sol";
import {KeeperGateway} from "../../src/hub/KeeperGateway.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockTigrisPool} from "../mocks/MockTigrisPool.sol";
import {MockTigrisRouter} from "../mocks/MockTigrisRouter.sol";
import {HubHandler, HubSystem, IHubPrices} from "./HubHandler.sol";

/// Whole-hub invariants under liquidations, write-offs, fees, flash loans, loops, BTC leverage and spoke collateral
/// with a non-zero hub Wormhole fee (see HubHandler for the actions).
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 96
contract HubInvariantTest is MessageFeeFixture, IHubPrices {
    /// Hub Wormhole fee paid by every RELEASE (remote withdrawal or liquidation of spoke collateral).
    uint256 internal constant HUB_MESSAGE_FEE = 0.0001 ether;
    /// Tigris testnet MUSD/BTC fee.
    uint256 internal constant SWAP_FEE_BPS = 4;

    HubHandler internal handler;
    MockTigrisPool internal pair;
    MockTigrisRouter internal router;
    LeverageManager internal lev;
    SwapLeverageManager internal swapLev;
    KeeperGateway internal gateway;
    address internal treasury = makeAddr("treasury");
    uint256 internal initialK;

    function setUp() public {
        setUpCrossChainWithHubFee(HUB_MESSAGE_FEE);
        setUpBtc();
        vaultManager.setTreasury(treasury);
        vaultManager.setLiquidationFee(1_000); // 10% of each liquidation bonus
        // A deep MUSD/BTC pool at the oracle price: 80M MUSD / 1,000 BTC.
        pair = new MockTigrisPool(address(musd), address(btc), SWAP_FEE_BPS);
        musd.mint(address(pair), 80_000_000e18);
        btc.mint(address(pair), 1_000e18);
        pair.sync();
        router = new MockTigrisRouter(pair);
        lev = new LeverageManager(vaultManager, pMUSD, musdMarket, pMusdCollateral);
        swapLev = new SwapLeverageManager(vaultManager, pMUSD, musdMarket, btcCollateral, pair);
        gateway = new KeeperGateway(vaultManager, adapter);
        (uint256 r0, uint256 r1,) = pair.getReserves();
        initialK = r0 * r1;

        handler = new HubHandler(_system());
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: handler.actions()}));
    }

    function _system() internal view returns (HubSystem memory) {
        return HubSystem({
            vaultManager: vaultManager,
            oracle: oracle,
            pMUSD: pMUSD,
            pMEZO: pMEZO,
            musd: musd,
            mezo: mezo,
            btc: btc,
            lev: lev,
            swapLev: swapLev,
            gateway: gateway,
            pair: pair,
            router: router,
            adapter: adapter,
            hubWormhole: hubWormhole,
            spokeWormhole: spokeWormhole,
            spoke: spoke,
            weth: weth,
            usdc: usdc,
            musdMarket: musdMarket,
            mezoMarket: mezoMarket,
            pMusdCollateral: pMusdCollateral,
            pMezoCollateral: pMezoCollateral,
            wethBase: wethBase,
            usdcBase: usdcBase,
            btcCollateral: btcCollateral,
            treasury: treasury,
            lp: lp,
            guardianKey: GUARDIAN_PK,
            hubChain: MEZO_CHAIN,
            spokeChain: BASE_SEPOLIA
        });
    }

    // --- IHubPrices (called by the handler) ---------------------------------------------------------------------

    function refreshPrices() external {
        pushPrices();
    }

    function setPrice(uint256 asset, int64 newPrice) external {
        if (asset == 0) mezoPrice = newPrice;
        else if (asset == 1) ethPrice = newPrice;
        else btcPrice = newPrice;
        pushPrices();
    }

    function price(uint256 asset) external view returns (int64) {
        return asset == 0 ? mezoPrice : asset == 1 ? ethPrice : btcPrice;
    }

    function taggedPriceUpdates() external view returns (bytes[] memory) {
        return priceUpdates();
    }

    // --- Invariants ---------------------------------------------------------------------------------------------

    /// Hub collateral: the VaultManager holds exactly the recorded total of every local id (pTokens and BTC), and the
    /// per-account balances (actors and treasury) add up to every id's total.
    function invariant_collateralEscrowMatchesTotals() public view {
        address[] memory accounts = handler.trackedAccounts();
        for (uint256 id = 0; id < vaultManager.collateralCount(); id++) {
            VaultManager.CollateralConfig memory c = vaultManager.collaterals(id);
            uint256 total = vaultManager.totalCollateral(id);
            if (!c.isRemote) assertEq(IERC20(c.token).balanceOf(address(vaultManager)), total, "escrow != total");
            uint256 sum;
            for (uint256 i = 0; i < accounts.length; i++) {
                sum += vaultManager.collateralBalance(accounts[i], id);
            }
            assertEq(sum, total, "account balances != totalCollateral");
        }
    }

    /// Spoke collateral: hub credit plus the RELEASEs still in flight is exactly what the spoke holds locked.
    function invariant_remoteCollateralBackedBySpoke() public view {
        _assertBacked(wethBase, weth);
        _assertBacked(usdcBase, usdc);
        assertEq(handler.violations(HubHandler.Check.CrossChain), 0, handler.firstViolation());
    }

    function invariant_debtsMatchTotalBorrows() public view {
        _assertDebts(pMUSD, 0);
        _assertDebts(pMEZO, 1);
    }

    /// A liquidation that takes an account's last collateral writes off everything it still owes (checked exactly by
    /// the handler as each one completes); and no tracked account owes anything, not even dust, without collateral.
    function invariant_noDebtWithoutCollateral() public view {
        assertEq(handler.violations(HubHandler.Check.BadDebt), 0, handler.firstViolation());
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            address a = handler.actors(i);
            if (_hasCollateral(a)) continue;
            assertEq(pMUSD.borrowBalanceView(a), 0, "MUSD debt without collateral");
            assertEq(pMEZO.borrowBalanceView(a), 0, "MEZO debt without collateral");
        }
    }

    /// Supplier share prices only ever fall across a BadDebtWrittenOff (the handler checks every action).
    function invariant_exchangeRateFallsOnlyOnWriteOff() public view {
        assertEq(handler.violations(HubHandler.Check.ExchangeRate), 0, handler.firstViolation());
    }

    /// LeverageManager, SwapLeverageManager, KeeperGateway and the adapter keep nothing between transactions, and no
    /// msg.value is ever left in VaultManager.
    function invariant_peripheryHoldsNothing() public view {
        address[4] memory holders = [address(lev), address(swapLev), address(gateway), address(adapter)];
        IERC20[5] memory tokens =
            [IERC20(address(musd)), IERC20(address(mezo)), IERC20(address(btc)), IERC20(pMUSD), IERC20(pMEZO)];
        for (uint256 i = 0; i < holders.length; i++) {
            for (uint256 j = 0; j < tokens.length; j++) {
                assertEq(tokens[j].balanceOf(holders[i]), 0, "periphery holds tokens");
            }
            assertEq(holders[i].balance, 0, "periphery holds native BTC");
        }
        assertEq(address(vaultManager).balance, 0, "VaultManager kept msg.value");
    }

    function invariant_tigrisKNeverDecreases() public view {
        assertEq(handler.violations(HubHandler.Check.TigrisK), 0, handler.firstViolation());
        (uint256 r0, uint256 r1,) = pair.getReserves();
        assertGe(r0 * r1, initialK, "k below its seed");
        // Every swap ends with reserves = balances; fees leave for the fee sink.
        assertEq(IERC20(pair.token0()).balanceOf(address(pair)), r0, "reserve0 != balance");
        assertEq(IERC20(pair.token1()).balanceOf(address(pair)), r1, "reserve1 != balance");
    }

    /// Reserves are exactly the reserve-factor share of interest plus flash-loan fees, less owner withdrawals and the
    /// bad debt they absorbed; the pools stay solvent with no flash loan left open.
    function invariant_reservesMatchLedger() public view {
        PToken[2] memory pools = [pMUSD, pMEZO];
        for (uint256 p = 0; p < 2; p++) {
            assertEq(pools[p].totalReserves(), handler.reserveLedger(p), "reserves != fee ledger");
            assertGe(pools[p].cash() + pools[p].totalBorrows(), pools[p].totalReserves(), "reserves exceed assets");
            assertEq(pools[p].flashOutstanding(), 0, "flash loan left open");
        }
        assertEq(handler.violations(HubHandler.Check.Reserves), 0, handler.firstViolation());
        assertEq(handler.violations(HubHandler.Check.FlashLoan), 0, handler.firstViolation());
    }

    /// Per-action checks: liquidation math (close factor, bonus, treasury cut, payment), the borrow limit after every
    /// limit-checked action, exact msg.value refunds, and leverage/repay accounting against return values.
    function invariant_actionChecks() public view {
        assertEq(handler.violations(HubHandler.Check.Liquidation), 0, handler.firstViolation());
        assertEq(handler.violations(HubHandler.Check.BorrowLimit), 0, handler.firstViolation());
        assertEq(handler.violations(HubHandler.Check.Refund), 0, handler.firstViolation());
        assertEq(handler.violations(HubHandler.Check.Accounting), 0, handler.firstViolation());
    }

    // --- Handler reach ------------------------------------------------------------------------------------------

    /// Scripted run through every action, so a handler that silently skips everything cannot pass the invariants
    /// vacuously: each path below must succeed at least once, and every invariant must hold afterwards.
    function test_handlerReachesEveryPath() public {
        address a0 = handler.actors(0);
        // MEZO collateral, MUSD debt at the limit, then a -70% crash: insolvent.
        handler.supplyAndPost(0, 1, 2_000_000e18);
        handler.borrow(0, 0, 1, 0);
        handler.shockPrice(0, 3_000);
        handler.liquidate(0, 0, 1, 0); // close factor: half the debt, part of the collateral
        handler.liquidateViaKeeper(0, 0, 1, pMUSD.borrowBalanceView(a0), 1); // takes the rest: write-off
        assertEq(pMUSD.borrowBalanceStored(a0), 0, "bad debt left");
        // Spoke WETH at the limit, ETH -20%, remote collateral liquidated and released on the spoke.
        handler.depositRemote(1, 0, 10e18);
        handler.borrow(1, 0, 1, 2);
        handler.shockPrice(1, 8_000);
        handler.liquidate(1, 0, 2, 0);
        handler.relayRelease(0);
        // A debt-free remote withdrawal, paying price updates and the Wormhole fee.
        handler.depositRemote(2, 1, 1_000e6);
        handler.withdrawCollateral(2, 3, 0, 1);
        handler.relayRelease(0);
        // The MUSD loop at 3×, a partial unwind, repay-with-collateral, then a full unwind.
        handler.loop(3, 10_000e18 + 1, 3e18, 0);
        handler.unwind(3, 1, 1_000e18, 4_000e24, 0);
        handler.repayWithCollateral(3, 0, 500e18);
        handler.unwind(3, 0, 0, 0, 3);
        // BTC leverage through the Tigris flash swap: open, partial close, full close.
        handler.openBtc(2, 1e18 + 2, 100_000e18, 0);
        handler.closeBtc(2, 1, 40_000e18, handler.quoteBtcToSell(40_000e18), 0);
        handler.closeBtc(2, 0, 0, 0, 2);
        // Flash loans (plain, with a supply round trip, refused while paused) and reserve admin.
        handler.flashLoan(0, 100_000e18, 0);
        handler.flashLoan(1, 1_000_000e18, 1);
        handler.flashLoan(0, 1e18, 2);
        handler.setReserveFactor(0, 0.2e18);
        handler.warp(30 days);
        handler.withdrawReserves(0, 1e18);
        // BTC -10% and an arbitrage back to the oracle price; collateral toggles; redemptions and repayment.
        handler.shockPrice(2, 9_000);
        handler.tradeTigris(10_000);
        handler.setCollateralEnabled(4, 0);
        handler.setCollateralEnabled(4, 1);
        handler.redeemShares(6, 0, 1e24);
        handler.repay(1, 0, 3);

        assertGt(handler.liquidations(), 1, "liquidations");
        assertGt(handler.keeperLiquidations(), 0, "keeper liquidations");
        assertGt(handler.writeOffs(), 0, "write-offs");
        assertGt(handler.remoteDeposits(), 1, "remote deposits");
        assertGt(handler.remoteWithdrawals(), 0, "remote withdrawals");
        assertEq(handler.releasesRelayed(), 2, "releases relayed");
        assertGt(handler.loops(), 0, "loops");
        assertGt(handler.partialUnwinds(), 0, "partial unwinds");
        assertGt(handler.collateralRepays(), 0, "repays with collateral");
        assertGt(handler.unwinds(), 0, "full unwinds");
        assertGt(handler.opens(), 0, "BTC opens");
        assertGt(handler.partialCloses(), 0, "partial BTC closes");
        assertGt(handler.closes(), 0, "full BTC closes");
        assertEq(handler.flashLoans(), 2, "flash loans");
        assertGt(handler.reserveWithdrawals(), 0, "reserve withdrawals");
        assertGt(handler.trades(), 0, "Tigris trades");
        assertEq(handler.pendingReleases(), 0, "releases left");

        invariant_collateralEscrowMatchesTotals();
        invariant_remoteCollateralBackedBySpoke();
        invariant_debtsMatchTotalBorrows();
        invariant_noDebtWithoutCollateral();
        invariant_exchangeRateFallsOnlyOnWriteOff();
        invariant_peripheryHoldsNothing();
        invariant_tigrisKNeverDecreases();
        invariant_reservesMatchLedger();
        invariant_actionChecks();
    }

    // --- Helpers ------------------------------------------------------------------------------------------------

    function _assertBacked(uint256 id, MockERC20 token) internal view {
        uint256 locked = spoke.locked(address(token));
        assertEq(vaultManager.totalCollateral(id) + handler.inFlight(address(token)), locked, "hub credit != locked");
        assertEq(token.balanceOf(address(spoke)), locked, "spoke balance != locked");
    }

    /// Σ tracked debts vs totalBorrows. Every debt rounds up and each debt change (borrow, repay, write-off, accrual)
    /// can carry that wei into a principal, while totalBorrows keeps index-truncation dust (Compound-style). Both
    /// compound with interest, so each side is bounded by its own tally times the index growth.
    function _assertDebts(PToken pool, uint256 p) internal view {
        uint256 n = handler.actorCount();
        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            sum += pool.borrowBalanceStored(handler.actors(i));
        }
        uint256 total = pool.totalBorrows();
        uint256 growth = pool.borrowIndex() / 1e18 + 1;
        assertLe(sum, total + (n + handler.debtEvents(p)) * growth, "debts exceed totalBorrows");
        assertLe(total - Math.min(sum, total), handler.truncationDust(p) * growth, "totalBorrows exceeds debts");
    }

    function _hasCollateral(address a) internal view returns (bool) {
        for (uint256 id = 0; id < vaultManager.collateralCount(); id++) {
            if (vaultManager.collateralBalance(a, id) != 0) return true;
        }
        return false;
    }
}
