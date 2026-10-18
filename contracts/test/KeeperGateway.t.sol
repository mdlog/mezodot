// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CrossChainFixture} from "./utils/CrossChainFixture.sol";
import {KeeperGateway} from "../src/hub/KeeperGateway.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";

contract KeeperGatewayTest is CrossChainFixture {
    KeeperGateway internal gateway;
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        setUpCrossChain();
        gateway = new KeeperGateway(vaultManager, adapter);
        musd.mint(keeper, 100_000e18);
        vm.prank(keeper);
        musd.approve(address(gateway), type(uint256).max);
    }

    function _underwaterLocal() internal {
        postLocal(alice, pMEZO, pMezoCollateral, 1_000_000e18);
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 3_900e18, noUpdates());
        mezoPrice = 476_400;
        pushPrices();
    }

    function test_liquidationPaysKeeperAndRefundsUnusedRepay() public {
        _underwaterLocal();
        vm.prank(keeper);
        uint256 seized =
            gateway.triggerLiquidation(alice, musdMarket, 10_000e18, pMezoCollateral, 0, bytes32(0), noUpdates());
        assertGt(seized, 0);
        assertEq(pMEZO.balanceOf(keeper), seized);
        // Close factor used ~1,950; the rest of the 10,000 pulled is returned.
        assertApproxEqRel(musd.balanceOf(keeper), 100_000e18 - 1_950e18, 1e9);
        assertEq(musd.balanceOf(address(gateway)), 0);
        (uint64 liquidations,) = gateway.stats(keeper);
        assertEq(liquidations, 1);
        assertEq(gateway.keeperCount(), 1);
    }

    function test_healthyPositionReverts() public {
        postLocal(alice, pMUSD, pMusdCollateral, 1_000e18);
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 100e18, noUpdates());
        vm.prank(keeper);
        vm.expectRevert(VaultManager.PositionHealthy.selector);
        gateway.triggerLiquidation(alice, musdMarket, 50e18, pMusdCollateral, 0, bytes32(0), noUpdates());
    }

    function test_relayCountsAndCredits() public {
        bytes memory vaa = spokeDeposit(alice, weth, 1e18);
        vm.prank(keeper);
        gateway.relayMessage(vaa);
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
        (, uint64 relays) = gateway.stats(keeper);
        assertEq(relays, 1);
    }

    function test_keeperCountIsUnique() public {
        address other = makeAddr("other");
        // Build VAAs first: vm.prank applies to the next external call only.
        bytes memory v1 = spokeDeposit(alice, weth, 1e18);
        bytes memory v2 = spokeDeposit(alice, weth, 1e18);
        bytes memory v3 = spokeDeposit(alice, weth, 1e18);
        vm.prank(keeper);
        gateway.relayMessage(v1);
        vm.prank(keeper);
        gateway.relayMessage(v2);
        vm.prank(other);
        gateway.relayMessage(v3);
        assertEq(gateway.keeperCount(), 2);
        assertTrue(gateway.isKeeper(other));
    }

    function test_snapshotPassthrough() public {
        postLocal(alice, pMUSD, pMusdCollateral, 1_000e18);
        assertEq(gateway.getRiskSnapshot(alice).collateralValue, vaultManager.getRiskSnapshot(alice).collateralValue);
    }

    function test_remoteLiquidationDefaultsReceiverToKeeper() public {
        adapter.receiveMessage(spokeDeposit(alice, weth, 1e18));
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 2_350e18, noUpdates());
        ethPrice = 2_800e8;
        pushPrices();
        vm.recordLogs();
        vm.prank(keeper);
        uint256 seized = gateway.triggerLiquidation(alice, musdMarket, 1_000e18, wethBase, 0, bytes32(0), noUpdates());
        spoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));
        assertEq(weth.balanceOf(keeper), seized);
    }

    function test_refundsExcessBtc() public {
        _underwaterLocal();
        vm.deal(keeper, 1 ether);
        bytes[] memory updates = priceUpdates();
        vm.prank(keeper);
        gateway.triggerLiquidation{value: 1 ether}(alice, musdMarket, 1_000e18, pMezoCollateral, 0, bytes32(0), updates);
        assertEq(keeper.balance, 1 ether - 4);
        assertEq(address(gateway).balance, 0);
    }

    /// Review: stray BTC must not block keeper contracts that cannot take BTC (a 1-wei donation used to revert them).
    function test_strayBtcDoesNotBlockKeeperContracts() public {
        _underwaterLocal();
        NoBtcKeeper bot = new NoBtcKeeper(gateway);
        musd.mint(address(bot), 10_000e18);
        vm.deal(address(gateway), 1);
        uint256 seized = bot.liquidate(alice, musdMarket, 1_000e18, pMezoCollateral);
        assertGt(seized, 0);
        assertEq(address(gateway).balance, 1); // waits for the next keeper that accepts it
    }

    /// Review: BTC sent to the gateway outside a liquidation used to be excluded from every refund, forever.
    function test_strayBtcIsNotStuck() public {
        _underwaterLocal();
        vm.deal(address(gateway), 0.5 ether); // e.g. a BTC precompile transfer by mistake
        vm.prank(keeper);
        gateway.triggerLiquidation(alice, musdMarket, 1_000e18, pMezoCollateral, 0, bytes32(0), noUpdates());
        assertEq(keeper.balance, 0.5 ether);
        assertEq(address(gateway).balance, 0);
    }
}

/// A keeper contract with no way to receive BTC (no receive or payable fallback).
contract NoBtcKeeper {
    KeeperGateway internal immutable gateway;

    constructor(KeeperGateway gateway_) {
        gateway = gateway_;
    }

    function liquidate(address account, uint256 marketId, uint256 repay, uint256 collateralId)
        external
        returns (uint256)
    {
        IERC20(address(gateway.vaultManager().markets(marketId).pool.asset())).approve(address(gateway), repay);
        return gateway.triggerLiquidation(account, marketId, repay, collateralId, 0, bytes32(0), new bytes[](0));
    }
}
