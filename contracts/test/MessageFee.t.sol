// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MessageFeeFixture} from "./utils/MessageFeeFixture.sol";
import {KeeperGateway} from "../src/hub/KeeperGateway.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {Payload} from "../src/libraries/Payload.sol";

/// Remote withdrawals and liquidations of spoke collateral publish a RELEASE through the hub's Wormhole core, whose
/// message fee is paid out of msg.value: msg.value must cover the price-update fee plus the message fee, any excess
/// comes back exactly, and underpaying reverts without the hub ever funding the fee itself.
contract MessageFeeTest is MessageFeeFixture {
    uint256 internal constant MESSAGE_FEE = 0.0003 ether;

    KeeperGateway internal gateway;
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        setUpCrossChainWithHubFee(MESSAGE_FEE);
        gateway = new KeeperGateway(vaultManager, adapter);
        vm.deal(alice, 1 ether);
        vm.deal(liquidator, 1 ether);
        vm.deal(keeper, 1 ether);
        musd.mint(liquidator, 10_000e18);
        musd.mint(keeper, 10_000e18);
        vm.prank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vm.prank(keeper);
        musd.approve(address(gateway), type(uint256).max);
    }

    // --- withdrawRemote ---------------------------------------------------------------------------------------

    function test_withdrawRemotePaysPriceUpdatesAndMessageFee() public {
        _creditWeth(alice, 1e18);
        bytes[] memory updates = priceUpdates();
        uint256 priceFee = oracle.updateFee(updates);
        assertGt(priceFee, 0);
        uint256 coreBefore = address(hubWormhole).balance;
        uint256 before = alice.balance;
        vm.recordLogs();
        vm.prank(alice);
        vaultManager.withdrawRemote{value: priceFee + MESSAGE_FEE}(wethBase, 0.4e18, _to(alice), updates);

        assertEq(alice.balance, before - priceFee - MESSAGE_FEE);
        assertEq(address(hubWormhole).balance, coreBefore + MESSAGE_FEE); // Wormhole got exactly its fee
        assertEq(address(vaultManager).balance, 0);
        assertEq(address(adapter).balance, 0);
        // The RELEASE it paid for executes on the spoke.
        spoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));
        assertEq(weth.balanceOf(alice), 0.4e18);
    }

    function test_withdrawRemoteRefundsExcessExactly() public {
        _creditWeth(alice, 1e18);
        bytes[] memory updates = priceUpdates();
        uint256 priceFee = oracle.updateFee(updates);
        uint256 before = alice.balance;
        vm.prank(alice);
        vaultManager.withdrawRemote{value: 0.5 ether}(wethBase, 0.4e18, _to(alice), updates);
        assertEq(alice.balance, before - priceFee - MESSAGE_FEE);
        assertEq(address(vaultManager).balance, 0);
    }

    function test_withdrawRemoteWithoutUpdatesOwesOnlyTheMessageFee() public {
        _creditWeth(alice, 1e18);
        uint256 before = alice.balance;
        vm.prank(alice);
        vaultManager.withdrawRemote{value: MESSAGE_FEE + 1}(wethBase, 1e18, _to(alice), noUpdates());
        assertEq(alice.balance, before - MESSAGE_FEE);
    }

    function test_withdrawRemoteUnderpaymentReverts() public {
        _creditWeth(alice, 1e18);
        bytes[] memory updates = priceUpdates();
        uint256 priceFee = oracle.updateFee(updates);
        // Short of the price-update fee: refused up front.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        vaultManager.withdrawRemote{value: priceFee - 1}(wethBase, 0.4e18, _to(alice), updates);
        // One wei short of the message fee: refused before the adapter is paid.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        vaultManager.withdrawRemote{value: priceFee + MESSAGE_FEE - 1}(wethBase, 0.4e18, _to(alice), updates);
        // No fee at all.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        vaultManager.withdrawRemote(wethBase, 0.4e18, _to(alice), noUpdates());
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
    }

    /// On Mezo the hub's BTC collateral is its native balance: a shortfall must be refused before the RELEASE is paid
    /// for, so the message can never be funded from users' BTC.
    function test_underpaidWithdrawalCannotSpendHubBtc() public {
        _creditWeth(alice, 1e18);
        vm.deal(address(vaultManager), 1 ether);
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        vaultManager.withdrawRemote{value: MESSAGE_FEE - 1}(wethBase, 0.4e18, _to(alice), noUpdates());
        assertEq(address(vaultManager).balance, 1 ether);
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
    }

    // --- Liquidation of remote collateral ----------------------------------------------------------------------

    function test_remoteLiquidationPaysFeesAndRefundsExcessExactly() public {
        _underwaterRemote();
        bytes[] memory updates = priceUpdates();
        uint256 priceFee = oracle.updateFee(updates);
        uint256 coreBefore = address(hubWormhole).balance;
        uint256 before = liquidator.balance;
        vm.recordLogs();
        vm.prank(liquidator);
        uint256 seized = vaultManager.liquidate{value: priceFee + MESSAGE_FEE + 0.2 ether}(
            alice, musdMarket, 1_000e18, wethBase, 0, liquidator, _to(liquidator), updates
        );
        assertEq(liquidator.balance, before - priceFee - MESSAGE_FEE);
        assertEq(address(hubWormhole).balance, coreBefore + MESSAGE_FEE);
        assertEq(address(vaultManager).balance, 0);
        spoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));
        assertEq(weth.balanceOf(liquidator), seized);
    }

    function test_remoteLiquidationUnderpaymentReverts() public {
        _underwaterRemote();
        bytes[] memory updates = priceUpdates();
        uint256 priceFee = oracle.updateFee(updates);
        vm.prank(liquidator);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        vaultManager.liquidate{value: priceFee - 1}(
            alice, musdMarket, 1_000e18, wethBase, 0, liquidator, _to(liquidator), updates
        );
        vm.prank(liquidator);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        vaultManager.liquidate{value: priceFee + MESSAGE_FEE - 1}(
            alice, musdMarket, 1_000e18, wethBase, 0, liquidator, _to(liquidator), updates
        );
        // Even with native BTC in the hub (Mezo), the shortfall is refused by the msg.value check.
        vm.deal(address(vaultManager), 1 ether);
        vm.prank(liquidator);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        vaultManager.liquidate{value: MESSAGE_FEE - 1}(
            alice, musdMarket, 1_000e18, wethBase, 0, liquidator, _to(liquidator), noUpdates()
        );
        assertEq(address(vaultManager).balance, 1 ether);
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
        assertEq(musd.balanceOf(liquidator), 10_000e18);
    }

    /// The keeper path forwards all msg.value; VaultManager returns what the fees did not use and the gateway passes
    /// every wei of it back to the keeper.
    function test_keeperRemoteLiquidationRefundsExcessExactly() public {
        _underwaterRemote();
        bytes[] memory updates = priceUpdates();
        uint256 priceFee = oracle.updateFee(updates);
        uint256 before = keeper.balance;
        vm.recordLogs();
        vm.prank(keeper);
        uint256 seized = gateway.triggerLiquidation{value: priceFee + MESSAGE_FEE + 0.3 ether}(
            alice, musdMarket, 1_000e18, wethBase, 0, bytes32(0), updates
        );
        assertEq(keeper.balance, before - priceFee - MESSAGE_FEE);
        assertEq(address(gateway).balance, 0);
        assertEq(address(vaultManager).balance, 0);
        // The remote receiver defaults to the keeper.
        spoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));
        assertEq(weth.balanceOf(keeper), seized);
    }

    function test_keeperRemoteLiquidationUnderpaymentReverts() public {
        _underwaterRemote();
        bytes[] memory updates = priceUpdates();
        uint256 priceFee = oracle.updateFee(updates);
        vm.prank(keeper);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        gateway.triggerLiquidation{value: priceFee - 1}(alice, musdMarket, 1_000e18, wethBase, 0, bytes32(0), updates);
        vm.prank(keeper);
        vm.expectRevert(VaultManager.InsufficientValue.selector);
        gateway.triggerLiquidation{value: priceFee + MESSAGE_FEE - 1}(
            alice, musdMarket, 1_000e18, wethBase, 0, bytes32(0), updates
        );
        assertEq(musd.balanceOf(keeper), 10_000e18);
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
    }

    /// Hub collateral is paid out on the hub: no RELEASE, so no message fee is owed and all excess value returns.
    function test_localLiquidationOwesNoMessageFee() public {
        postLocal(alice, pMEZO, pMezoCollateral, 1_000_000e18);
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 3_900e18, noUpdates());
        mezoPrice = 476_400; // -40%
        pushPrices();
        uint256 coreBefore = address(hubWormhole).balance;
        uint256 before = keeper.balance;
        vm.prank(keeper);
        gateway.triggerLiquidation{value: 0.1 ether}(
            alice, musdMarket, 1_000e18, pMezoCollateral, 0, bytes32(0), noUpdates()
        );
        assertEq(keeper.balance, before);
        assertEq(address(hubWormhole).balance, coreBefore);
    }

    // --- Helpers ------------------------------------------------------------------------------------------------

    function _creditWeth(address who, uint256 amount) internal {
        adapter.receiveMessage(spokeDeposit(who, weth, amount));
    }

    /// 1 WETH at $3,200 (75% LTV) backing 2,350 MUSD; ETH then falls to $2,800: HF = 2,800 × 0.80 / 2,350 ≈ 0.95.
    function _underwaterRemote() internal {
        _creditWeth(alice, 1e18);
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 2_350e18, noUpdates());
        ethPrice = 2_800e8;
        pushPrices();
    }

    function _to(address a) internal pure returns (bytes32) {
        return Payload.toBytes32(a);
    }
}
