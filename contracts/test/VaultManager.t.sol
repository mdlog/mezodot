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
