// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {OracleRouter} from "../src/hub/OracleRouter.sol";

contract OracleRouterTest is Test {
    bytes32 internal constant ETH_ID = bytes32(uint256(0xE7));
    bytes32 internal constant MEZO_ID = bytes32(uint256(0x3E20));
    bytes32 internal constant ETH = keccak256("ETH");
    bytes32 internal constant MEZO = keccak256("MEZO");

    MockPyth internal pyth;
    OracleRouter internal oracle;

    function setUp() public {
        vm.warp(1_000_000);
        pyth = new MockPyth(60, 1 wei);
        oracle = new OracleRouter(pyth, 120, 200, address(this));
        oracle.setFeed(ETH, ETH_ID);
        oracle.setFeed(MEZO, MEZO_ID);
    }

    function _update(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime) internal {
        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.createPriceFeedUpdateData(id, price, conf, expo, price, conf, publishTime);
        oracle.updatePrices{value: 1 wei}(updates);
    }

    function test_normalisesNegativeExponentToWad() public {
        _update(ETH_ID, 3_200_00000000, 1_00000000, -8, uint64(block.timestamp));
        assertEq(oracle.getPrice(ETH), 3_200e18);
    }

    function test_normalisesSmallPrices() public {
        // MEZO ≈ $0.00794 with expo -8
        _update(MEZO_ID, 794_000, 1_000, -8, uint64(block.timestamp));
        assertEq(oracle.getPrice(MEZO), 0.00794e18);
    }

    function test_normalisesPositiveExponent() public {
        _update(ETH_ID, 32, 0, 2, uint64(block.timestamp));
        assertEq(oracle.getPrice(ETH), 3_200e18);
    }

    /// Review Focus 3: stale prices revert for risk checks, views still return them with a timestamp.
    function test_stalePriceRevertsButUnsafeViewReturns() public {
        _update(ETH_ID, 3_200_00000000, 1_00000000, -8, uint64(block.timestamp));
        skip(121);
        vm.expectRevert(PythErrors.StalePrice.selector);
        oracle.getPrice(ETH);
        (uint256 price, uint256 publishTime) = oracle.getPriceUnsafe(ETH);
        assertEq(price, 3_200e18);
        assertEq(publishTime, block.timestamp - 121);
    }

    /// A configured feed that was never pushed on-chain (common on Mezo for pull feeds) must not
    /// break views: getPriceUnsafe returns zero; the strict getPrice still reverts.
    function test_neverUpdatedFeedIsZeroInViews() public {
        (uint256 price, uint256 publishTime) = oracle.getPriceUnsafe(ETH);
        assertEq(price, 0);
        assertEq(publishTime, 0);
        vm.expectRevert(PythErrors.PriceFeedNotFound.selector);
        oracle.getPrice(ETH);
    }

    function test_lowConfidenceReverts() public {
        // conf 3% of price > 2% limit
        _update(ETH_ID, 100_00000000, 3_00000000, -8, uint64(block.timestamp));
        vm.expectRevert(OracleRouter.PriceUncertain.selector);
        oracle.getPrice(ETH);
    }

    function test_nonPositivePriceReverts() public {
        _update(ETH_ID, 0, 0, -8, uint64(block.timestamp));
        vm.expectRevert(OracleRouter.InvalidPrice.selector);
        oracle.getPrice(ETH);
    }

    function test_unknownKeyReverts() public {
        vm.expectRevert(OracleRouter.UnknownFeed.selector);
        oracle.getPrice(keccak256("NOPE"));
    }

    function test_updatePaysFeeAndRefundsExcess() public {
        address payer = makeAddr("payer");
        vm.deal(payer, 1 ether);
        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.createPriceFeedUpdateData(ETH_ID, 1e8, 0, -8, 1e8, 0, uint64(block.timestamp));
        vm.prank(payer);
        uint256 fee = oracle.updatePrices{value: 1 ether}(updates);
        assertEq(fee, 1 wei);
        assertEq(payer.balance, 1 ether - 1 wei);
        assertEq(oracle.updateFee(updates), 1 wei);
    }

    function test_emptyUpdateIsFree() public {
        bytes[] memory none = new bytes[](0);
        assertEq(oracle.updatePrices(none), 0);
    }

    function test_insufficientFeeReverts() public {
        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.createPriceFeedUpdateData(ETH_ID, 1e8, 0, -8, 1e8, 0, uint64(block.timestamp));
        vm.expectRevert(OracleRouter.InsufficientFee.selector);
        oracle.updatePrices(updates);
    }

    /// Final review M4: a zero-fee Pyth deployment must still receive the updates.
    function test_zeroFeeUpdatesArePushed() public {
        MockPyth freePyth = new MockPyth(60, 0);
        OracleRouter router = new OracleRouter(freePyth, 120, 200, address(this));
        router.setFeed(ETH, ETH_ID);
        bytes[] memory updates = new bytes[](1);
        updates[0] = freePyth.createPriceFeedUpdateData(ETH_ID, 3_200e8, 0, -8, 3_200e8, 0, uint64(block.timestamp));
        assertEq(router.updatePrices(updates), 0);
        assertEq(router.getPrice(ETH), 3_200e18);
    }

    function test_tryGetPrice() public {
        (bool ok, uint256 price) = oracle.tryGetPrice(ETH); // never pushed
        assertFalse(ok);
        assertEq(price, 0);
        _update(ETH_ID, 3_200_00000000, 1_00000000, -8, uint64(block.timestamp));
        (ok, price) = oracle.tryGetPrice(ETH);
        assertTrue(ok);
        assertEq(price, 3_200e18);
        skip(121);
        (ok,) = oracle.tryGetPrice(ETH); // stale
        assertFalse(ok);
        _update(MEZO_ID, 100_00000000, 3_00000000, -8, uint64(block.timestamp));
        (ok,) = oracle.tryGetPrice(MEZO); // 3% confidence
        assertFalse(ok);
        (ok,) = oracle.tryGetPrice(keccak256("NOPE")); // unknown key
        assertFalse(ok);
    }

    function test_onlyOwnerSetsFeeds() public {
        vm.prank(makeAddr("x"));
        vm.expectRevert();
        oracle.setFeed(ETH, bytes32(0));
    }

    receive() external payable {}
}
