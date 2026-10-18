// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HubFixture} from "./utils/HubFixture.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract VaultManagerTest is HubFixture {
    uint256 internal constant WAD = 1e18;

    function setUp() public {
        setUpHub();
        // The test contract plays the WormholeAdapter so remote credits can be injected directly.
        vaultManager.setAdapter(address(this));
    }

    function _borrow(address who, uint256 marketId, uint256 amount) internal {
        vm.prank(who);
        vaultManager.borrow(marketId, amount, noUpdates());
    }

    // --- Collateral ------------------------------------------------------------

    function test_depositAndWithdrawLocalCollateral() public {
        uint256 shares = postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), shares);
        assertEq(pMUSD.balanceOf(address(vaultManager)), shares);
        vm.prank(alice);
        vaultManager.withdrawCollateral(pMusdCollateral, shares, alice, noUpdates());
        assertEq(pMUSD.balanceOf(alice), shares);
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), 0);
    }

    function test_cannotDepositRemoteCollateralLocally() public {
        vm.expectRevert(VaultManager.InvalidCollateral.selector);
        vaultManager.depositCollateral(wethBase, 1);
    }

    function test_capEnforced() public {
        vaultManager.setCollateralParams(pMusdCollateral, 8000, 8500, 500, 1, true);
        uint256 shares = supplyFor(alice, pMUSD, 10e18);
        vm.startPrank(alice);
        pMUSD.approve(address(vaultManager), shares);
        vm.expectRevert(VaultManager.CapExceeded.selector);
        vaultManager.depositCollateral(pMusdCollateral, shares);
        vm.stopPrank();
    }

    // --- Borrowing ---------------------------------------------------------------

    function test_borrowWithinLtv() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 7_999e18); // LTV 80%
        assertEq(musd.balanceOf(alice), 7_999e18);
        assertEq(pMUSD.borrowBalanceStored(alice), 7_999e18);
    }

    function test_borrowOverLtvReverts() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.borrow(musdMarket, 8_001e18, noUpdates());
    }

    function test_borrowAgainstRemoteCollateral() public {
        vaultManager.creditRemote(alice, wethBase, 2.4e18); // $7,680
        _borrow(alice, musdMarket, 3_120e18);
        VaultManager.RiskSnapshot memory s = vaultManager.getRiskSnapshot(alice);
        assertEq(s.collateralValue, 7_680e18);
        assertEq(s.debtValue, 3_120e18);
        assertEq(s.borrowLimit, 5_760e18); // 75%
        // HF = 7,680 × 0.80 / 3,120
        assertApproxEqRel(s.healthFactor, 1.969230769e18, 1e9);
    }

    function test_usdcSixDecimalsValuedCorrectly() public {
        vaultManager.creditRemote(alice, usdcBase, 1_000e6);
        assertEq(vaultManager.getRiskSnapshot(alice).collateralValue, 1_000e18);
    }

    function test_borrowMezoAgainstPMusd() public {
        postLocal(alice, pMUSD, pMusdCollateral, 1_000e18); // $1,000 → limit $800
        uint256 maxMezo = 800e18 * 1e8 / uint256(int256(mezoPrice));
        _borrow(alice, mezoMarket, maxMezo - 1e18);
        assertEq(mezo.balanceOf(alice), maxMezo - 1e18);
    }

    function test_borrowUsesFreshPricesFromUpdate() public {
        vaultManager.creditRemote(alice, wethBase, 1e18);
        skip(200); // stored prices are now stale
        vm.prank(alice);
        vm.expectRevert();
        vaultManager.borrow(musdMarket, 100e18, noUpdates());
        vm.deal(alice, 1 ether);
        bytes[] memory updates = priceUpdates(); // build before prank: it makes external calls
        vm.prank(alice);
        vaultManager.borrow{value: 1 ether}(musdMarket, 100e18, updates);
        // Excess BTC refunded (4 updates × 1 wei fee).
        assertEq(alice.balance, 1 ether - 4);
    }

    function test_repayPartialAllAndOnBehalf() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 5_000e18);
        vm.startPrank(alice);
        musd.approve(address(vaultManager), type(uint256).max);
        assertEq(vaultManager.repay(musdMarket, 1_000e18, alice), 1_000e18);
        vm.stopPrank();
        skip(10 days);
        address friend = makeAddr("friend");
        musd.mint(friend, 10_000e18);
        vm.startPrank(friend);
        musd.approve(address(vaultManager), type(uint256).max);
        uint256 applied = vaultManager.repay(musdMarket, type(uint256).max, alice);
        vm.stopPrank();
        assertGt(applied, 4_000e18);
        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        vm.expectRevert(VaultManager.NothingToRepay.selector);
        vaultManager.repay(musdMarket, 1, alice);
    }

    /// Review Focus 4: withdrawals that would leave the account over its borrow limit revert.
    function test_withdrawBreakingLtvReverts() public {
        uint256 shares = postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 7_000e18);
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.withdrawCollateral(pMusdCollateral, shares / 5, alice, noUpdates());
        // A small withdrawal that keeps LTV ≤ 80% is fine.
        vm.prank(alice);
        vaultManager.withdrawCollateral(pMusdCollateral, shares / 20, alice, noUpdates());
    }

    function test_operatorGating() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        address op = makeAddr("operator");
        vm.prank(op);
        vm.expectRevert(VaultManager.NotOperator.selector);
        vaultManager.borrowFor(alice, musdMarket, 1e18, op, noUpdates());
        vm.prank(alice);
        vaultManager.setOperator(op, true);
        vm.prank(op);
        vaultManager.borrowFor(alice, musdMarket, 1e18, op, noUpdates());
        assertEq(musd.balanceOf(op), 1e18);
        assertEq(pMUSD.borrowBalanceStored(alice), 1e18);
    }

    function test_onlyAdapterCredits() public {
        vm.prank(alice);
        vm.expectRevert(VaultManager.NotAdapter.selector);
        vaultManager.creditRemote(alice, wethBase, 1e18);
    }

    // --- Plain-token collateral (BTC) ------------------------------------------------

    function _postBtc(address who, uint256 amount) internal {
        btc.mint(who, amount);
        vm.startPrank(who);
        btc.approve(address(vaultManager), amount);
        vaultManager.depositCollateral(btcCollateral, amount);
        vm.stopPrank();
    }

    function test_btcCollateralValuedUnitForUnit() public {
        setUpBtc();
        _postBtc(alice, 1e18);
        // 1 BTC at $80,000 with no exchange rate in between.
        assertEq(vaultManager.collateralValue(alice, btcCollateral), 80_000e18);
        VaultManager.RiskSnapshot memory s = vaultManager.getRiskSnapshot(alice);
        assertEq(s.borrowLimit, 56_000e18);
        _borrow(alice, musdMarket, 50_000e18);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        _borrow(alice, musdMarket, 6_001e18);
    }

    function test_btcLiquidationSeizesTokensNotShares() public {
        setUpBtc();
        _postBtc(alice, 1e18);
        _borrow(alice, musdMarket, 56_000e18);
        btcPrice = 70_000e8; // HF = 70,000 × 0.78 / 56,000 = 0.975
        pushPrices();
        musd.mint(liquidator, 30_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        uint256 seized =
            vaultManager.liquidate(alice, musdMarket, 28_000e18, btcCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();
        // 28,000 repaid × 1.05 bonus at $70,000 per BTC.
        assertApproxEqRel(seized, uint256(28_000e18) * 10_500 / 10_000 * 1e18 / 70_000e18, 1e9);
        assertEq(btc.balanceOf(liquidator), seized);
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), 1e18 - seized);
    }

    function test_remoteAndShareFlagsMustAgree() public {
        VaultManager.CollateralConfig memory c = _remote(ETH_SEPOLIA, SPOKE_WETH, 18, ETH_KEY, 7500, 8000, 700);
        c.isShare = true;
        vm.expectRevert(VaultManager.InvalidCollateral.selector);
        vaultManager.addCollateral(c);
    }

    // --- Repay with collateral (same pool) ---------------------------------------------

    function test_repayWithCollateralNetsDebtAgainstShares() public {
        uint256 shares = postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 6_000e18);
        uint256 rate = pMUSD.exchangeRate();
        uint256 cash = pMUSD.cash();
        vm.prank(alice);
        (uint256 repaid, uint256 burned) =
            vaultManager.repayWithCollateral(alice, musdMarket, pMusdCollateral, type(uint256).max);
        assertEq(repaid, 6_000e18);
        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), shares - burned);
        assertApproxEqAbs(vaultManager.collateralValue(alice, pMusdCollateral), 4_000e18, 1e6);
        assertEq(pMUSD.cash(), cash); // no cash moved
        assertGe(pMUSD.exchangeRate(), rate); // suppliers are never diluted
        assertEq(pMUSD.balanceOf(address(vaultManager)), vaultManager.totalCollateral(pMusdCollateral));
    }

    function test_repayWithCollateralWorksWithNoIdleCash() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 6_000e18);
        address bob = makeAddr("bob");
        vaultManager.creditRemote(bob, wethBase, 1_000e18);
        _borrow(bob, musdMarket, pMUSD.cash());
        assertEq(pMUSD.cash(), 0);
        vm.prank(alice);
        vaultManager.repayWithCollateral(alice, musdMarket, pMusdCollateral, 2_000e18);
        assertEq(pMUSD.borrowBalanceStored(alice), 4_000e18);
    }

    function test_repayWithCollateralRules() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        vm.prank(alice);
        vm.expectRevert(VaultManager.NothingToRepay.selector);
        vaultManager.repayWithCollateral(alice, musdMarket, pMusdCollateral, 1e18);
        _borrow(alice, musdMarket, 1_000e18);
        // Only the account or its operator.
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(VaultManager.NotOperator.selector);
        vaultManager.repayWithCollateral(alice, musdMarket, pMusdCollateral, 1e18);
        vm.startPrank(alice);
        // Shares of another pool, or remote collateral, cannot repay this market.
        vm.expectRevert(VaultManager.InvalidCollateral.selector);
        vaultManager.repayWithCollateral(alice, musdMarket, pMezoCollateral, 1e18);
        vm.expectRevert(VaultManager.InvalidCollateral.selector);
        vaultManager.repayWithCollateral(alice, musdMarket, wethBase, 1e18);
        vm.expectRevert(VaultManager.ZeroAmount.selector);
        vaultManager.repayWithCollateral(alice, musdMarket, pMusdCollateral, 0);
        vm.stopPrank();
    }

    /// Burning the last collateral while debt remains would leave bad debt that no liquidation can write off.
    function test_repayWithCollateralCannotLeaveBadDebt() public {
        setUpBtc();
        postLocal(alice, pMUSD, pMusdCollateral, 5_000e18);
        _postBtc(alice, 0.1e18); // $8,000
        _borrow(alice, musdMarket, 8_500e18);
        btcPrice = 16_000e8; // -80%: the BTC is liquidated in full and the debt left exceeds the pMUSD
        pushPrices();
        musd.mint(liquidator, 5_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vaultManager.liquidate(alice, musdMarket, 4_250e18, btcCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), 0);
        assertGt(pMUSD.borrowBalanceStored(alice), vaultManager.collateralValue(alice, pMusdCollateral));

        vm.prank(alice);
        vm.expectRevert(VaultManager.WouldLeaveBadDebt.selector);
        vaultManager.repayWithCollateral(alice, musdMarket, pMusdCollateral, type(uint256).max);
        // Netting only part of it keeps collateral behind for the liquidation that writes the rest off.
        vm.prank(alice);
        vaultManager.repayWithCollateral(alice, musdMarket, pMusdCollateral, 1_000e18);
    }

    // --- Disabled collateral ---------------------------------------------------------

    function test_disabledCollateralBacksNoNewBorrowingButKeepsHealth() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 4_000e18);
        vaultManager.setCollateralParams(pMusdCollateral, 8000, 8500, 500, type(uint256).max, false);
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.borrow(musdMarket, 1e18, noUpdates());
        VaultManager.RiskSnapshot memory snap = vaultManager.getRiskSnapshot(alice);
        assertEq(snap.borrowLimit, 0);
        assertApproxEqRel(snap.healthFactor, 2.125e18, 1e12); // 10,000 × 85% / 4,000: not liquidatable
    }

    function test_disabledRemoteCollateralIsStillCreditedWithoutBorrowingPower() public {
        vaultManager.setCollateralParams(wethBase, 7500, 8000, 700, type(uint256).max, false);
        vaultManager.creditRemote(alice, wethBase, 1e18); // tokens are already locked on the spoke
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.borrow(musdMarket, 1e18, noUpdates());
    }

    // --- Listing checks ----------------------------------------------------------------

    function test_addCollateralChecksKindAndDecimals() public {
        MockERC20 six = new MockERC20("Six", "SIX", 6);
        // A plain token is valued unit for unit at the configured decimals, so they must be the token's.
        vm.expectRevert(VaultManager.InvalidCollateral.selector);
        vaultManager.addCollateral(_plain(address(six), USDC_KEY, 5000, 6000, 500));
        // Share collateral is valued through its pool's exchange rate: it must be a listed market pool.
        vm.expectRevert(VaultManager.InvalidCollateral.selector);
        vaultManager.addCollateral(_local(address(six), USDC_KEY, 5000, 6000, 500));
        VaultManager.CollateralConfig memory c = _plain(address(six), USDC_KEY, 5000, 6000, 500);
        c.decimals = 6;
        vaultManager.addCollateral(c);
    }

    // --- Liquidation protocol fee --------------------------------------------------

    function test_liquidationFeeGoesToTreasury() public {
        address treasury = makeAddr("treasury");
        vaultManager.setTreasury(treasury);
        vaultManager.setLiquidationFee(1_000); // 10% of the bonus
        _underwaterMezoBorrower();
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        uint256 received =
            vaultManager.liquidate(alice, musdMarket, 10_000e18, pMezoCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();

        // Seized at a 10% bonus: the bonus is 1/11 of it, and the protocol keeps a tenth of that.
        uint256 fee = vaultManager.collateralBalance(treasury, pMezoCollateral);
        uint256 seized = received + fee;
        assertApproxEqAbs(fee, seized * 1_000 / 11_000 / 10, 1);
        assertEq(pMEZO.balanceOf(liquidator), received);
        // The fee stays in custody as the treasury's collateral; totals still match the tokens held.
        assertEq(vaultManager.totalCollateral(pMezoCollateral), pMEZO.balanceOf(address(vaultManager)));
        vm.prank(treasury);
        vaultManager.withdrawCollateral(pMezoCollateral, fee, treasury, noUpdates());
        assertEq(pMEZO.balanceOf(treasury), fee);
    }

    function test_liquidationFeeAppliesToMinSeizeOnWhatTheLiquidatorGets() public {
        vaultManager.setLiquidationFee(1_000);
        _underwaterMezoBorrower();
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        uint256 snap = vm.snapshotState();
        uint256 received =
            vaultManager.liquidate(alice, musdMarket, 1_000e18, pMezoCollateral, 0, liquidator, 0, noUpdates());
        vm.revertToState(snap);
        vm.expectRevert(VaultManager.SlippageExceeded.selector);
        vaultManager.liquidate(alice, musdMarket, 1_000e18, pMezoCollateral, received + 1, liquidator, 0, noUpdates());
        vm.stopPrank();
    }

    function test_liquidationFeeAdminBounds() public {
        uint16 cap = vaultManager.MAX_LIQUIDATION_FEE_BPS();
        vm.expectRevert(VaultManager.InvalidParams.selector);
        vaultManager.setLiquidationFee(cap + 1);
        vm.expectRevert(VaultManager.InvalidParams.selector);
        vaultManager.setTreasury(address(0));
        assertEq(vaultManager.treasury(), address(this));
        assertEq(vaultManager.liquidationFeeBps(), 0);
        vm.prank(alice);
        vm.expectRevert();
        vaultManager.setLiquidationFee(500);
    }

    // --- Liquidation ---------------------------------------------------------------

    function _underwaterMezoBorrower() internal returns (uint256 shares) {
        // 1,000,000 MEZO ≈ $7,940 at 50% LTV → borrow $3,900 MUSD, then MEZO drops 40%.
        shares = postLocal(alice, pMEZO, pMezoCollateral, 1_000_000e18);
        _borrow(alice, musdMarket, 3_900e18);
        mezoPrice = 476_400; // -40%
        pushPrices();
    }

    function test_liquidationRequiresHfBelowOne() public {
        postLocal(alice, pMEZO, pMezoCollateral, 1_000_000e18);
        _borrow(alice, musdMarket, 3_900e18);
        musd.mint(liquidator, 2_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vm.expectRevert(VaultManager.PositionHealthy.selector);
        vaultManager.liquidate(alice, musdMarket, 1_000e18, pMezoCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();
    }

    function test_liquidationSeizesWithBonusAndCloseFactor() public {
        _underwaterMezoBorrower();
        assertLt(vaultManager.getRiskSnapshot(alice).healthFactor, WAD);
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        uint256 seized =
            vaultManager.liquidate(alice, musdMarket, 10_000e18, pMezoCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();
        // Close factor caps repayment at 50% of the 3,900 debt.
        // (debt grew by a few seconds of interest while prices were pushed)
        assertApproxEqRel(musd.balanceOf(liquidator), 10_000e18 - 1_950e18, 1e9);
        assertApproxEqRel(pMUSD.borrowBalanceStored(alice), 1_950e18, 1e9);
        // Seized value = 1,950 × 1.10 at $0.004764 per MEZO.
        uint256 crashed = 476_400;
        uint256 expectedMezo = 1_950e18 * 11_000 / 10_000 * 1e8 / crashed;
        assertApproxEqRel(pMEZO.convertToAssets(seized), expectedMezo, 1e9);
        assertEq(pMEZO.balanceOf(liquidator), seized);
    }

    function test_liquidationMinSeizeGuard() public {
        _underwaterMezoBorrower();
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vm.expectRevert(VaultManager.SlippageExceeded.selector);
        vaultManager.liquidate(
            alice, musdMarket, 1_000e18, pMezoCollateral, type(uint256).max, liquidator, 0, noUpdates()
        );
        vm.stopPrank();
    }

    function test_liquidationCappedByAvailableCollateral() public {
        uint256 shares = _underwaterMezoBorrower();
        mezoPrice = 100_000; // collapse: collateral worth ~$1,000 against $3,900 debt
        pushPrices();
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        uint256 seized =
            vaultManager.liquidate(alice, musdMarket, 1_950e18, pMezoCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();
        assertEq(seized, shares);
        assertEq(vaultManager.collateralBalance(alice, pMezoCollateral), 0);
        // Repayment scaled down to the collateral actually seized.
        assertLt(10_000e18 - musd.balanceOf(liquidator), 1_950e18);
    }

    /// Audit pool#0: once the last collateral is seized, the debt left over is written off instead of staying in
    /// totalBorrows forever (accruing interest nobody pays and inflating utilisation, so every honest borrower's
    /// rate). Reserves absorb the loss first; the rest lowers the pMUSD exchange rate for all suppliers.
    function test_liquidationWritesOffDebtLeftWithoutCollateral() public {
        _underwaterMezoBorrower();
        mezoPrice = 100_000; // collapse: collateral worth ~$1,000 against $3,900 debt
        pushPrices();
        pMUSD.accrueInterest();
        uint256 owed = pMUSD.borrowBalanceStored(alice);
        uint256 reservesBefore = pMUSD.totalReserves();
        uint256 rateBefore = pMUSD.exchangeRate();
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vm.expectEmit(true, true, false, false, address(vaultManager));
        emit VaultManager.BadDebtWrittenOff(alice, musdMarket, 0);
        vaultManager.liquidate(alice, musdMarket, 1_950e18, pMezoCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();
        uint256 repaid = 10_000e18 - musd.balanceOf(liquidator);
        uint256 badDebt = owed - repaid;

        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        assertEq(pMUSD.totalBorrows(), 0); // alice was the only borrower
        assertEq(pMUSD.totalReserves(), reservesBefore > badDebt ? reservesBefore - badDebt : 0);
        // Suppliers share what reserves could not cover, pro rata through the exchange rate.
        uint256 supply = pMUSD.totalSupply();
        uint256 lost = badDebt - (reservesBefore > badDebt ? badDebt : reservesBefore);
        assertApproxEqRel(rateBefore - pMUSD.exchangeRate(), lost * 10 ** pMUSD.decimals() / supply, 1e12);
        // Nothing keeps accruing for a debt nobody will repay.
        skip(365 days);
        pMUSD.accrueInterest();
        assertEq(pMUSD.totalBorrows(), 0);
    }

    function test_noWriteOffWhileOtherCollateralRemains() public {
        _underwaterMezoBorrower();
        vaultManager.creditRemote(alice, wethBase, 0.01e18); // $32 of WETH still backs the debt
        mezoPrice = 100_000;
        pushPrices();
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vaultManager.liquidate(alice, musdMarket, 1_950e18, pMezoCollateral, 0, liquidator, 0, noUpdates());
        vm.stopPrank();
        assertEq(vaultManager.collateralBalance(alice, pMezoCollateral), 0);
        assertGt(pMUSD.borrowBalanceStored(alice), 2_900e18); // still owed: a later liquidation can take the WETH
    }

    // --- Admin & pause ---------------------------------------------------------------

    function test_pauseBlocksBorrowNotRepayOrWithdraw() public {
        uint256 shares = postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 1_000e18);
        vaultManager.pause();
        vm.prank(alice);
        vm.expectRevert();
        vaultManager.borrow(musdMarket, 1e18, noUpdates());
        vm.startPrank(alice);
        musd.approve(address(vaultManager), type(uint256).max);
        vaultManager.repay(musdMarket, type(uint256).max, alice);
        vaultManager.withdrawCollateral(pMusdCollateral, shares, alice, noUpdates());
        vm.stopPrank();
    }

    function test_rejectsUnsafeCollateralParams() public {
        vm.expectRevert(VaultManager.InvalidParams.selector);
        vaultManager.setCollateralParams(pMusdCollateral, 9000, 8500, 500, 0, true); // ltv > lt
        vm.expectRevert(VaultManager.InvalidParams.selector);
        vaultManager.setCollateralParams(pMusdCollateral, 9000, 9600, 500, 0, true); // lt > 95%
        vm.expectRevert(VaultManager.InvalidParams.selector);
        vaultManager.setCollateralParams(pMusdCollateral, 8000, 9500, 1000, 0, true); // lt × (1+bonus) > 100%
    }

    function test_duplicateCollateralRejected() public {
        vm.expectRevert(VaultManager.InvalidCollateral.selector);
        vaultManager.addCollateral(_remote(BASE_SEPOLIA, SPOKE_WETH, 18, ETH_KEY, 7500, 8000, 700));
    }

    function test_snapshotSurvivesFeedNeverPushed() public {
        bytes32 newKey = keccak256("NEW");
        oracle.setFeed(newKey, pythFeed(bytes32(uint256(0x9999))));
        vaultManager.addCollateral(_remote(ETH_SEPOLIA, SPOKE_WETH, 18, newKey, 7500, 8000, 700));
        vaultManager.creditRemote(alice, vaultManager.collateralCount() - 1, 1e18);
        postLocal(alice, pMUSD, pMusdCollateral, 1_000e18);
        VaultManager.RiskSnapshot memory s = vaultManager.getRiskSnapshot(alice);
        assertEq(s.collateralValue, 1_000e18); // unpriced collateral counts as zero in views
    }

    function test_snapshotNoDebtHasMaxHealth() public {
        postLocal(alice, pMUSD, pMusdCollateral, 1e18);
        assertEq(vaultManager.getRiskSnapshot(alice).healthFactor, type(uint256).max);
    }

    function testFuzz_borrowLimitHolds(uint96 deposit, uint96 borrowAmt) public {
        deposit = uint96(bound(deposit, 1e18, 1_000_000e18));
        borrowAmt = uint96(bound(borrowAmt, 1, deposit));
        postLocal(alice, pMUSD, pMusdCollateral, deposit);
        vm.prank(alice);
        try vaultManager.borrow(musdMarket, borrowAmt, noUpdates()) {
            VaultManager.RiskSnapshot memory s = vaultManager.getRiskSnapshot(alice);
            assertLe(s.debtValue, s.borrowLimit);
        } catch {
            assertGt(uint256(borrowAmt) * 10_000, uint256(deposit) * 8_000 - 1e18);
        }
    }

    // --- Final review I2 / I3 / M6 ----------------------------------------------------

    function test_setAdapterIsOneShot() public {
        vm.expectRevert(VaultManager.AdapterAlreadySet.selector);
        vaultManager.setAdapter(makeAddr("newAdapter"));
    }

    /// Without debt nothing is at risk: withdrawing must not depend on oracle liveness.
    function test_debtFreeWithdrawNeedsNoFreshPrices() public {
        uint256 shares = postLocal(alice, pMUSD, pMusdCollateral, 1_000e18);
        uint256 mezoShares = postLocal(alice, pMEZO, pMezoCollateral, 1_000e18);
        skip(1 days); // every stored price is now stale
        vm.startPrank(alice);
        vaultManager.withdrawCollateral(pMusdCollateral, shares, alice, noUpdates());
        vaultManager.withdrawCollateral(pMezoCollateral, mezoShares, alice, noUpdates());
        vm.stopPrank();
        assertEq(pMUSD.balanceOf(alice), shares);
        assertEq(pMEZO.balanceOf(alice), mezoShares);
    }

    /// Collateral whose price is unavailable counts as zero for borrow/withdraw limits instead of
    /// blocking the account, while debt is still priced strictly.
    function test_staleCollateralCountsAsZeroForLimits() public {
        uint256 musdShares = postLocal(alice, pMUSD, pMusdCollateral, 10_000e18); // $10,000 x 80%
        postLocal(alice, pMEZO, pMezoCollateral, 1_000_000e18); // ~$7,940 x 50%
        _borrow(alice, musdMarket, 1_000e18);

        skip(200); // MEZO goes stale; refresh everything except MEZO
        bytes[] memory updates = new bytes[](3);
        uint64 t = uint64(block.timestamp);
        updates[0] = pyth.createPriceFeedUpdateData(MUSD_ID, musdPrice, 0, -8, musdPrice, 0, t);
        updates[1] = pyth.createPriceFeedUpdateData(ETH_ID, ethPrice, 0, -8, ethPrice, 0, t);
        updates[2] = pyth.createPriceFeedUpdateData(USDC_ID, usdcPrice, 0, -8, usdcPrice, 0, t);
        pyth.updatePriceFeeds{value: pyth.getUpdateFee(updates)}(updates);

        // Half the pMUSD can leave: 5,000 x 80% = 4,000 >= 1,000 debt, ignoring MEZO.
        vm.prank(alice);
        vaultManager.withdrawCollateral(pMusdCollateral, musdShares / 2, alice, noUpdates());
        // But stale MEZO adds no borrowing power: 4,000 limit, 1,000 owed.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.borrow(musdMarket, 3_500e18, noUpdates());
        _borrow(alice, musdMarket, 2_900e18);
    }

    function test_debtStillPricedStrictly() public {
        postLocal(alice, pMUSD, pMusdCollateral, 10_000e18);
        _borrow(alice, musdMarket, 1_000e18);
        skip(200); // MUSD (the debt asset) is stale
        vm.prank(alice);
        vm.expectRevert(); // StalePrice on the debt price
        vaultManager.withdrawCollateral(pMusdCollateral, 1, alice, noUpdates());
    }

    /// Gifting collateral to another account (which could add an oracle dependency) is no longer possible.
    function test_depositCollateralForRequiresOperator() public {
        address griefer = makeAddr("griefer");
        uint256 shares = supplyFor(griefer, pMEZO, 1e18);
        vm.startPrank(griefer);
        pMEZO.approve(address(vaultManager), shares);
        vm.expectRevert(VaultManager.NotOperator.selector);
        vaultManager.depositCollateralFor(alice, pMezoCollateral, 1);
        vm.stopPrank();

        vm.prank(alice);
        vaultManager.setOperator(griefer, true);
        vm.prank(griefer);
        vaultManager.depositCollateralFor(alice, pMezoCollateral, 1);
        assertEq(vaultManager.collateralBalance(alice, pMezoCollateral), 1);
    }

    /// Pause must never stop a borrower from defending a position by adding collateral.
    function test_collateralTopUpAllowedWhilePaused() public {
        uint256 shares = supplyFor(alice, pMUSD, 1_000e18);
        vaultManager.pause();
        vm.startPrank(alice);
        pMUSD.approve(address(vaultManager), shares);
        vaultManager.depositCollateral(pMusdCollateral, shares);
        vm.stopPrank();
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), shares);
    }

    receive() external payable {}
}
