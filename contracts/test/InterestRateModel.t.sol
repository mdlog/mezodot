// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {InterestRateModel} from "../src/hub/InterestRateModel.sol";

contract InterestRateModelTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 365 days;
    // MUSD params from the spec: base 0%, slope1 6%, kink 80%, slope2 80%.
    InterestRateModel internal irm = new InterestRateModel(0, 0.06e18, 0.8e18, 0.8e18);

    function _annual(uint256 cash, uint256 borrows) internal view returns (uint256) {
        return irm.borrowRatePerSecond(cash, borrows, 0) * YEAR;
    }

    function test_utilization() public view {
        assertEq(irm.utilization(100, 0, 0), 0);
        assertEq(irm.utilization(20, 80, 0), 0.8e18);
        // Reserves are excluded from the supply base.
        assertEq(irm.utilization(30, 80, 10), 0.8e18);
        assertEq(irm.utilization(0, 0, 0), 0);
    }

    function test_rateAtKeyPoints() public view {
        assertApproxEqRel(_annual(100, 0), 0, 1e12);
        assertApproxEqRel(_annual(60, 40), 0.03e18, 1e12); // 50% util -> 3%
        assertApproxEqRel(_annual(20, 80), 0.06e18, 1e12); // kink -> 6%
        assertApproxEqRel(_annual(0, 100), 0.86e18, 1e12); // 100% -> 6% + 80%
    }

    function testFuzz_supplyRateNeverExceedsBorrowTimesUtil(uint96 cash, uint96 borrows, uint64 rf) public view {
        rf = uint64(bound(rf, 0, WAD));
        uint256 b = irm.borrowRatePerSecond(cash, borrows, 0);
        uint256 s = irm.supplyRatePerSecond(cash, borrows, 0, rf);
        uint256 u = irm.utilization(cash, borrows, 0);
        assertLe(s, b * u / WAD);
        assertLe(s, b);
    }

    function test_rejectsKinkOutOfRange() public {
        vm.expectRevert(InterestRateModel.InvalidParams.selector);
        new InterestRateModel(0, 0.06e18, 0, 0.8e18);
        vm.expectRevert(InterestRateModel.InvalidParams.selector);
        new InterestRateModel(0, 0.06e18, WAD, 0.8e18);
    }
}
