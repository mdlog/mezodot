// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HubFixture} from "./utils/HubFixture.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {LeverageManager} from "../src/hub/LeverageManager.sol";

contract LeverageManagerTest is HubFixture {
    uint256 internal constant WAD = 1e18;
    LeverageManager internal lev;

    function setUp() public {
        setUpHub();
        lev = new LeverageManager(vaultManager, pMUSD, musdMarket, pMusdCollateral);
        musd.mint(alice, 10_000e18);
        vm.startPrank(alice);
        musd.approve(address(lev), type(uint256).max);
        vaultManager.setOperator(address(lev), true);
        vm.stopPrank();
    }

    function _loop(uint256 principal, uint256 leverage) internal returns (uint256 shares, uint256 debt) {
        vm.prank(alice);
        (shares, debt) = lev.loop(principal, leverage, 0, noUpdates());
    }

    /// PRD flow C: 1,000 MUSD at 3× → flash borrow 2,000, supply 3,000, borrow 2,000 (+fee), repay flash.
    function test_prdFlowC_loop3x() public {
        (uint256 shares, uint256 debt) = _loop(1_000e18, 3e18);
        uint256 flashFee = pMUSD.flashFee(address(musd), 2_000e18);
        assertEq(flashFee, 1.8e18);
        assertEq(debt, 2_000e18 + flashFee);
        assertEq(musd.balanceOf(alice), 9_000e18);
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), shares);
        assertApproxEqAbs(pMUSD.convertToAssets(shares), 3_000e18, 1e6);
        assertEq(pMUSD.borrowBalanceStored(alice), debt);

        VaultManager.RiskSnapshot memory s = vaultManager.getRiskSnapshot(alice);
        // HF = 3,000 × 0.85 / 2,001.8
        assertApproxEqRel(s.healthFactor, uint256(3_000e18) * 8500 / 10_000 * WAD / 2_001.8e18, 1e9);
        // Nothing left behind in the manager.
        assertEq(musd.balanceOf(address(lev)), 0);
        assertEq(pMUSD.balanceOf(address(lev)), 0);
    }

    function test_leverageAboveLtvReverts() public {
        // 6× → debt/collateral = 5/6 ≈ 83% > 80% LTV
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        lev.loop(1_000e18, 6e18, 0, noUpdates());
    }

    function test_leverageMustExceedOne() public {
        vm.prank(alice);
        vm.expectRevert(LeverageManager.InvalidLeverage.selector);
        lev.loop(1_000e18, 1e18, 0, noUpdates());
    }

    function test_minSharesGuard() public {
        vm.prank(alice);
        vm.expectRevert(LeverageManager.SlippageExceeded.selector);
        lev.loop(1_000e18, 3e18, type(uint256).max, noUpdates());
    }

    function test_requiresOperatorApproval() public {
        vm.prank(alice);
        vaultManager.setOperator(address(lev), false);
        vm.prank(alice);
        vm.expectRevert(VaultManager.NotOperator.selector);
        lev.loop(1_000e18, 3e18, 0, noUpdates());
    }

    function test_unwindReturnsEquity() public {
        _loop(1_000e18, 3e18);
        vm.prank(alice);
        (uint256 out, uint256 sharesReturned) = lev.unwind(type(uint256).max, type(uint256).max, 0, noUpdates());
        // Equity back minus two flash fees (open 1.8 + close ≈1.8), all in MUSD while the pool has the cash.
        assertApproxEqAbs(out, 1_000e18 - 3.6e18, 0.01e18);
        assertEq(sharesReturned, 0);
        assertEq(musd.balanceOf(alice), 9_000e18 + out);
        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), 0);
    }

    /// Audit (leverage#0): a full unwind used to redeem every pMUSD share inside the flash loan, so it needed
    /// idle cash for the whole collateral (debt + equity) and reverted at moderate utilisation. Now it redeems
    /// what the pool can pay (at least the flash repayment) and returns the rest of the equity as pMUSD.
    function test_unwindAtHighUtilisationReturnsUnpaidEquityAsPTokens() public {
        _loop(1_000e18, 3e18); // collateral 3,000 pMUSD, debt 2,001.8 MUSD
        // Another borrower drains idle cash down to 2,500 MUSD (less than Alice's 3,000 of collateral).
        address bob = makeAddr("bob");
        vaultManager.setAdapter(address(this));
        vaultManager.creditRemote(bob, wethBase, 1_000e18);
        uint256 drain = pMUSD.cash() - 2_500e18; // computed before the prank: it is an external call
        vm.prank(bob);
        vaultManager.borrow(musdMarket, drain, noUpdates());

        vm.prank(alice);
        (uint256 out, uint256 sharesReturned) = lev.unwind(type(uint256).max, type(uint256).max, 990e18, noUpdates());
        uint256 closeFee = pMUSD.flashFee(address(musd), 2_001.8e18);
        assertApproxEqAbs(out, 2_500e18 - 2_001.8e18 - closeFee, 1e6); // all the cash the pool had, minus the flash
        assertEq(pMUSD.balanceOf(alice), sharesReturned);
        assertApproxEqAbs(pMUSD.convertToAssets(sharesReturned), 500e18, 1e6); // the rest, still earning
        assertEq(pMUSD.borrowBalanceStored(alice), 0);
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), 0);
        assertEq(musd.balanceOf(address(lev)), 0);
        assertEq(pMUSD.balanceOf(address(lev)), 0);
    }

    function test_unwindMinOutGuard() public {
        _loop(1_000e18, 3e18);
        vm.prank(alice);
        vm.expectRevert(LeverageManager.SlippageExceeded.selector);
        lev.unwind(type(uint256).max, type(uint256).max, 1_000e18, noUpdates());
    }

    /// Review Focus 5: unwinding collateral that still backs other hub debt reverts and returns nothing.
    function test_unwindLeavingDebtOverLimitReverts() public {
        (uint256 shares,) = _loop(1_000e18, 2e18); // collateral 2,000, debt ≈1,000.9
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 500e18, noUpdates()); // extra hub debt backed by loop collateral
        uint256 loopDebt = 1_000e18 + pMUSD.flashFee(address(musd), 1_000e18);
        uint256 balanceBefore = musd.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        lev.unwind(loopDebt, shares, 0, noUpdates());
        assertEq(musd.balanceOf(alice), balanceBefore);
    }

    function test_onFlashLoanRejectsForeignCallers() public {
        vm.expectRevert(LeverageManager.UnauthorizedCallback.selector);
        lev.onFlashLoan(address(lev), address(musd), 1, 0, "");
    }

    function testFuzz_loopRespectsBorrowLimit(uint64 principal, uint64 leverageBps) public {
        principal = uint64(bound(principal, 1e18, 10_000e18));
        leverageBps = uint64(bound(leverageBps, 10_001, 40_000)); // 1.0001× … 4×
        vm.prank(alice);
        lev.loop(principal, uint256(leverageBps) * 1e14, 0, noUpdates());
        VaultManager.RiskSnapshot memory s = vaultManager.getRiskSnapshot(alice);
        assertLe(s.debtValue, s.borrowLimit);
        assertGe(s.healthFactor, WAD);
    }
}
