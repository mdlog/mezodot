// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HubFixture} from "./utils/HubFixture.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {SwapLeverageManager} from "../src/hub/SwapLeverageManager.sol";
import {ITigrisPool} from "../src/interfaces/ITigrisPool.sol";
import {MockTigrisPool} from "./mocks/MockTigrisPool.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract SwapLeverageManagerTest is HubFixture {
    uint256 internal constant WAD = 1e18;
    address internal carol = makeAddr("carol");
    /// Tigris testnet MUSD/BTC fee.
    uint256 internal constant SWAP_FEE_BPS = 4;
    MockTigrisPool internal pair;
    SwapLeverageManager internal manager;

    function setUp() public {
        setUpHub();
        setUpBtc();
        // A deep pool at the oracle price, 80,000 MUSD per BTC: 80M MUSD / 1,000 BTC.
        pair = new MockTigrisPool(address(musd), address(btc), SWAP_FEE_BPS);
        musd.mint(address(pair), 80_000_000e18);
        btc.mint(address(pair), 1_000e18);
        pair.sync();
        manager = new SwapLeverageManager(vaultManager, pMUSD, musdMarket, btcCollateral, pair);
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
        // 1 BTC of equity to 2.5x: borrow 120,000 MUSD, buy ≈ 1.5 BTC, post ≈ 2.5 BTC.
        uint256 quoted = pair.getAmountOut(120_000e18, address(musd));
        (uint256 posted, uint256 debt) = _open(1e18, 120_000e18, quoted);
        assertEq(posted, 1e18 + quoted);
        assertEq(debt, 120_000e18); // no flash fee: the debt is exactly what was borrowed
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), posted);
        assertEq(pMUSD.borrowBalanceStored(alice), 120_000e18);
        // The borrow paid the pool directly: it holds the MUSD in, net of its 0.04% fee, and paid out the quote.
        assertEq(musd.balanceOf(address(pair)), 80_000_000e18 + 120_000e18 - 48e18);
        assertEq(btc.balanceOf(address(pair)), 1_000e18 - quoted);
        // HF ≈ 2.4978 × 80,000 × 0.78 / 120,000 ≈ 1.299.
        assertApproxEqRel(vaultManager.getRiskSnapshot(alice).healthFactor, 1.2988e18, 2e15);
        assertEq(btc.balanceOf(address(manager)), 0);
        assertEq(musd.balanceOf(address(manager)), 0);
    }

    function test_openNeedsOnlyTheBorrowInPoolCash() public {
        // Pool cash equal to the borrow is enough: no flash loan is taken from the MUSD market on top of it.
        uint256 borrowAmount = 60_000e18;
        uint256 excess = musd.balanceOf(address(pMUSD)) - borrowAmount;
        vm.prank(lp);
        pMUSD.withdraw(excess, lp, lp);
        _open(1e18, borrowAmount, 0);
        assertEq(pMUSD.borrowBalanceStored(alice), borrowAmount);
        assertEq(musd.balanceOf(address(pMUSD)), 0);
    }

    function test_openRevertsOnSlippage() public {
        uint256 quoted = pair.getAmountOut(120_000e18, address(musd));
        // Someone sells MUSD into the pool first, moving the price against us.
        musd.mint(address(this), 4_000_000e18);
        musd.transfer(address(pair), 4_000_000e18);
        bool btcIs0 = pair.token0() == address(btc);
        pair.swap(btcIs0 ? 40e18 : 0, btcIs0 ? 0 : 40e18, makeAddr("trader"), "");
        vm.prank(alice);
        vm.expectRevert(SwapLeverageManager.SlippageExceeded.selector);
        manager.open(1e18, 120_000e18, quoted, block.timestamp, noUpdates());
    }

    function test_openBeyondLtvReverts() public {
        // ≈ 3.5 BTC = $280,000 at 70% LTV supports $196,000; borrowing 200,000 is too much.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        manager.open(1e18, 200_000e18, 0, block.timestamp, noUpdates());
    }

    function test_openNeedsOperatorApproval() public {
        address dave = makeAddr("dave");
        btc.mint(dave, 1e18);
        vm.startPrank(dave);
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

    function test_openZeroAmountsRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(SwapLeverageManager.ZeroAmount.selector);
        manager.open(0, 10_000e18, 0, block.timestamp, noUpdates());
        vm.expectRevert(SwapLeverageManager.ZeroAmount.selector);
        manager.open(1e18, 0, 0, block.timestamp, noUpdates());
        vm.stopPrank();
    }

    function test_closeRepaysAllAndReturnsTheRest() public {
        _open(1e18, 120_000e18, 0);
        uint256 posted = vaultManager.collateralBalance(alice, btcCollateral);
        // Sell enough BTC for the debt, with a little margin for the price and fee.
        uint256 debt = pMUSD.borrowBalanceCurrent(alice);
        uint256 sell = debt * WAD / 80_000e18 * 10_050 / 10_000;
        uint256 proceeds = pair.getAmountOut(sell, address(btc));
        vm.prank(alice);
        (uint256 collateralOut, uint256 musdOut) =
            manager.close(type(uint256).max, type(uint256).max, sell, debt, block.timestamp, noUpdates());

        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), 0);
        assertEq(collateralOut, posted - sell);
        assertEq(musdOut, proceeds - debt);
        assertEq(btc.balanceOf(alice), collateralOut);
        assertEq(musd.balanceOf(alice), musdOut);
        // The round trip costs two swap fees and the price impact: equity back ≈ 1 BTC minus well under 0.5%.
        uint256 equityBack = collateralOut * 80_000 + musdOut;
        assertApproxEqRel(equityBack, 80_000e18, 5e15);
        assertLt(equityBack, 80_000e18);
        assertEq(btc.balanceOf(address(manager)), 0);
        assertEq(musd.balanceOf(address(manager)), 0);
    }

    function test_closeWorksWhenTheMarketIsFullyLent() public {
        _open(1e18, 120_000e18, 0);
        // Every remaining MUSD in the pool is borrowed by someone else: close must not need pool cash.
        uint256 cash = musd.balanceOf(address(pMUSD));
        _borrowAll(cash);
        assertEq(musd.balanceOf(address(pMUSD)), 0);
        uint256 debt = pMUSD.borrowBalanceCurrent(alice);
        uint256 sell = debt * WAD / 80_000e18 * 10_050 / 10_000;
        vm.prank(alice);
        manager.close(type(uint256).max, type(uint256).max, sell, 0, block.timestamp, noUpdates());
        assertEq(pMUSD.borrowBalanceStored(alice), 0);
    }

    function test_closeRepayingMoreThanTheDebtLeavesNothingBehind() public {
        _open(1e18, 120_000e18, 0);
        // A third party repays half the debt before alice's close (signed for the full 120,000) lands.
        musd.mint(carol, 60_000e18);
        vm.startPrank(carol);
        musd.approve(address(vaultManager), 60_000e18);
        vaultManager.repay(musdMarket, 60_000e18, alice);
        vm.stopPrank();

        uint256 sell = 1.6e18;
        uint256 proceeds = pair.getAmountOut(sell, address(btc));
        vm.prank(alice);
        (, uint256 musdOut) = manager.close(120_000e18, type(uint256).max, sell, 0, block.timestamp, noUpdates());
        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        assertEq(musdOut, proceeds - 60_000e18);
        assertEq(musd.balanceOf(address(manager)), 0);
        assertEq(btc.balanceOf(address(manager)), 0);
    }

    function test_closeSellingTooLittleReverts() public {
        _open(1e18, 120_000e18, 0);
        // 1.4 BTC raises ≈ 111,900 MUSD, short of the 120,000 debt.
        vm.prank(alice);
        vm.expectRevert(SwapLeverageManager.SlippageExceeded.selector);
        manager.close(type(uint256).max, type(uint256).max, 1.4e18, 0, block.timestamp, noUpdates());
    }

    function test_closeRespectsMinProceeds() public {
        _open(1e18, 120_000e18, 0);
        uint256 sell = 1.6e18;
        uint256 proceeds = pair.getAmountOut(sell, address(btc));
        vm.prank(alice);
        vm.expectRevert(SwapLeverageManager.SlippageExceeded.selector);
        manager.close(type(uint256).max, type(uint256).max, sell, proceeds + 1, block.timestamp, noUpdates());
    }

    function test_closeSellingMoreThanWithdrawnReverts() public {
        _open(1e18, 120_000e18, 0);
        vm.prank(alice);
        vm.expectRevert(SwapLeverageManager.ZeroAmount.selector);
        manager.close(type(uint256).max, 1e18, 1.5e18, 0, block.timestamp, noUpdates());
    }

    function test_partialCloseKeepsPositionHealthy() public {
        _open(1e18, 120_000e18, 0);
        uint256 posted = vaultManager.collateralBalance(alice, btcCollateral);
        // Repay half and take out only what keeps the rest within its limit.
        vm.prank(alice);
        manager.close(60_000e18, 0.8e18, 0.76e18, 0, block.timestamp, noUpdates());
        assertEq(pMUSD.borrowBalanceStored(alice), 60_000e18);
        assertEq(vaultManager.collateralBalance(alice, btcCollateral), posted - 0.8e18);
        assertGt(vaultManager.getRiskSnapshot(alice).healthFactor, 1.7e18);
    }

    function test_hookCannotBeCalledDirectly() public {
        bytes memory data = abi.encode(SwapLeverageManager.Action.Open, alice, 1, 0);
        vm.expectRevert(SwapLeverageManager.UnauthorizedCallback.selector);
        manager.hook(address(manager), 0, 1e18, data);
        // Not even by the pair itself, outside our own swap.
        vm.prank(address(pair));
        vm.expectRevert(SwapLeverageManager.UnauthorizedCallback.selector);
        manager.hook(address(manager), 0, 1e18, data);
    }

    function test_swapByAnotherCallerCannotUseTheHook() public {
        // A third party flash-swaps from the pair to the manager: the hook refuses, so nothing is borrowed for alice.
        bytes memory data = abi.encode(SwapLeverageManager.Action.Open, alice, 0, 10_000e18);
        bool btcIs0 = pair.token0() == address(btc);
        vm.expectRevert(SwapLeverageManager.UnauthorizedCallback.selector);
        pair.swap(btcIs0 ? 0.1e18 : 0, btcIs0 ? 0 : 0.1e18, address(manager), data);
    }

    function test_rejectsAPairWithoutBothTokens() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        MockTigrisPool wrong = new MockTigrisPool(address(musd), address(other), SWAP_FEE_BPS);
        vm.expectRevert(SwapLeverageManager.InvalidPair.selector);
        new SwapLeverageManager(vaultManager, pMUSD, musdMarket, btcCollateral, ITigrisPool(address(wrong)));
    }

    function test_rejectsIdsThatDoNotMatch() public {
        // The pMUSD collateral id is a pool share, not a plain token.
        vm.expectRevert(SwapLeverageManager.InvalidConfig.selector);
        new SwapLeverageManager(vaultManager, pMUSD, musdMarket, pMusdCollateral, pair);
        // The MEZO market is not the pMUSD pool's market.
        vm.expectRevert(SwapLeverageManager.InvalidConfig.selector);
        new SwapLeverageManager(vaultManager, pMUSD, mezoMarket, btcCollateral, pair);
    }

    function test_configuredForThePair() public view {
        assertEq(address(manager.pair()), address(pair));
        assertEq(address(manager.collateral()), address(btc));
        assertEq(address(manager.debtAsset()), address(musd));
    }

    /// Lends out every MUSD left in the market to a separate, well-collateralised borrower.
    function _borrowAll(uint256 amount) internal {
        address whale = makeAddr("whale");
        btc.mint(whale, 100e18);
        vm.startPrank(whale);
        btc.approve(address(vaultManager), 100e18);
        vaultManager.depositCollateral(btcCollateral, 100e18);
        vaultManager.borrow(musdMarket, amount, noUpdates());
        vm.stopPrank();
    }
}
