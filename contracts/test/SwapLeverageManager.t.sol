// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HubFixture} from "./utils/HubFixture.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {SwapLeverageManager} from "../src/hub/SwapLeverageManager.sol";
import {ITigrisRouter} from "../src/interfaces/ITigrisRouter.sol";
import {MockTigrisRouter} from "./mocks/MockTigrisRouter.sol";

contract SwapLeverageManagerTest is HubFixture {
    uint256 internal constant WAD = 1e18;
    MockTigrisRouter internal router;
    SwapLeverageManager internal manager;
    address internal tigrisFactory = makeAddr("tigrisFactory");

    function setUp() public {
        setUpHub();
        setUpBtc();
        router = new MockTigrisRouter();
        // The DEX quotes BTC at the oracle price: 80,000 MUSD per BTC.
        router.setRate(address(musd), address(btc), WAD / 80_000);
        router.setRate(address(btc), address(musd), 80_000 * WAD);
        manager = new SwapLeverageManager(vaultManager, pMUSD, musdMarket, btcCollateral, router, tigrisFactory, false);
        btc.mint(alice, 1e18);
        vm.startPrank(alice);
        btc.approve(address(manager), type(uint256).max);
        vaultManager.setOperator(address(manager), true);
        vm.stopPrank();
    }

    function _open(uint256 principal, uint256 borrowAmount, uint256 minBought)
        internal
        returns (uint256 posted, uint256 debt)
    {
        vm.prank(alice);
        (posted, debt) = manager.open(principal, borrowAmount, minBought, block.timestamp, noUpdates());
    }

    function test_openLeveragesBtcInOneTransaction() public {
        // 1 BTC of equity to 2.5x: borrow 120,000 MUSD, buy 1.5 BTC, post 2.5 BTC.
        (uint256 posted, uint256 debt) = _open(1e18, 120_000e18, 1.49e18);
        assertEq(posted, 2.5e18);
        assertEq(debt, 120_108e18); // 120,000 plus the 0.09% flash fee
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), 2.5e18);
        assertEq(pMUSD.borrowBalanceStored(alice), 120_108e18);
        // HF = 2.5 × 80,000 × 0.78 / 120,108 ≈ 1.299.
        assertApproxEqRel(vaultManager.getRiskSnapshot(alice).healthFactor, 1.2988e18, 1e15);
        assertEq(btc.balanceOf(address(manager)), 0);
        assertEq(musd.balanceOf(address(manager)), 0);
    }

    function test_openRevertsOnSlippage() public {
        router.setRate(address(musd), address(btc), WAD / 84_000); // the DEX moved 5% against us
        vm.prank(alice);
        vm.expectRevert(bytes("Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        manager.open(1e18, 120_000e18, 1.49e18, block.timestamp, noUpdates());
    }

    function test_openBeyondLtvReverts() public {
        // 3.5 BTC = $280,000 at 70% LTV supports $196,000; borrowing 200,000 (+ fee) is too much.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        manager.open(1e18, 200_000e18, 0, block.timestamp, noUpdates());
    }

    function test_openNeedsOperatorApproval() public {
        address bob = makeAddr("bob");
        btc.mint(bob, 1e18);
        vm.startPrank(bob);
        btc.approve(address(manager), 1e18);
        vm.expectRevert(VaultManager.NotOperator.selector);
        manager.open(1e18, 10_000e18, 0, block.timestamp, noUpdates());
        vm.stopPrank();
    }

    function test_openExpired() public {
        vm.prank(alice);
        vm.expectRevert(SwapLeverageManager.Expired.selector);
        manager.open(1e18, 10_000e18, 0, block.timestamp - 1, noUpdates());
    }

    function test_closeRepaysAllAndReturnsTheRest() public {
        _open(1e18, 120_000e18, 0);
        // Sell enough BTC for the debt plus the 0.09% flash fee on it, with a little margin.
        uint256 debt = pMUSD.borrowBalanceCurrent(alice);
        uint256 sell = (debt + debt * 9 / 10_000) * WAD / 80_000e18 + 0.001e18;
        vm.prank(alice);
        (uint256 collateralOut, uint256 musdOut) =
            manager.close(type(uint256).max, type(uint256).max, sell, 0, block.timestamp, noUpdates());

        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), 0);
        assertEq(collateralOut, 2.5e18 - sell);
        assertEq(btc.balanceOf(alice), collateralOut);
        assertEq(musd.balanceOf(alice), musdOut);
        // Two flash fees (open and close) are the round trip's cost: equity back ≈ 1 BTC − 216 MUSD.
        uint256 equityBack = collateralOut * 80_000 + musdOut;
        assertApproxEqRel(equityBack, 80_000e18 - 216e18, 1e14);
        assertEq(btc.balanceOf(address(manager)), 0);
        assertEq(musd.balanceOf(address(manager)), 0);
    }

    function test_closeSellingTooLittleReverts() public {
        _open(1e18, 120_000e18, 0);
        vm.prank(alice);
        vm.expectRevert(bytes("Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        manager.close(type(uint256).max, type(uint256).max, 1.4e18, 0, block.timestamp, noUpdates());
    }

    function test_partialCloseKeepsPositionHealthy() public {
        _open(1e18, 120_000e18, 0);
        // Repay half and take out only what keeps the rest within its limit.
        vm.prank(alice);
        manager.close(60_000e18, 0.8e18, 0.76e18, 0, block.timestamp, noUpdates());
        assertApproxEqRel(pMUSD.borrowBalanceStored(alice), 60_108e18, 1e12);
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), 1.7e18);
        assertGt(vaultManager.getRiskSnapshot(alice).healthFactor, 1.7e18);
    }

    function test_flashCallbackCannotBeCalledDirectly() public {
        vm.expectRevert(SwapLeverageManager.UnauthorizedCallback.selector);
        manager.onFlashLoan(
            address(manager), address(musd), 1e18, 0, abi.encode(SwapLeverageManager.Action.Open, alice, 1, 0, 0)
        );
    }

    function test_routeUsesConfiguredPool() public view {
        assertEq(manager.factory(), tigrisFactory);
        assertFalse(manager.stable());
        assertEq(address(manager.collateral()), address(btc));
        ITigrisRouter.Route[] memory r = new ITigrisRouter.Route[](1);
        r[0] = ITigrisRouter.Route({from: address(btc), to: address(musd), stable: false, factory: tigrisFactory});
        assertEq(router.getAmountsOut(1e18, r)[1], 80_000e18);
    }
}
