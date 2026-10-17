// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CrossChainFixture} from "./utils/CrossChainFixture.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {WormholeAdapter} from "../src/hub/WormholeAdapter.sol";
import {SpokeGateway} from "../src/spoke/SpokeGateway.sol";
import {Payload} from "../src/libraries/Payload.sol";
import {DevWormhole} from "./mocks/DevWormhole.sol";

contract CrossChainTest is CrossChainFixture {
    function setUp() public {
        setUpCrossChain();
    }

    // --- Spoke -> Hub ---------------------------------------------------------

    function test_prdFlowB_depositOnSpokeCreditsHub() public {
        bytes memory vaa = spokeDeposit(alice, weth, 2.4e18);
        assertEq(weth.balanceOf(address(spoke)), 2.4e18);
        assertEq(spoke.locked(address(weth)), 2.4e18);
        assertEq(vaultManager.collateralBalance(alice, wethBase), 0); // nothing until relayed

        bytes32 hash = adapter.receiveMessage(vaa);
        assertTrue(adapter.isConsumed(hash));
        assertEq(vaultManager.collateralBalance(alice, wethBase), 2.4e18);
        assertEq(vaultManager.getRiskSnapshot(alice).collateralValue, 7_680e18);

        // Borrow MUSD on the hub against wETH that never left the spoke.
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 3_120e18, noUpdates());
        assertEq(musd.balanceOf(alice), 3_120e18);
    }

    function test_usdcDeposit() public {
        adapter.receiveMessage(spokeDeposit(alice, usdc, 5_000e6));
        assertEq(vaultManager.getRiskSnapshot(alice).collateralValue, 5_000e18);
    }

    /// Review Focus 2: replayed VAAs and foreign emitters never credit.
    function test_replayReverts() public {
        bytes memory vaa = spokeDeposit(alice, weth, 1e18);
        adapter.receiveMessage(vaa);
        vm.expectRevert(WormholeAdapter.AlreadyConsumed.selector);
        adapter.receiveMessage(vaa);
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
    }

    function test_unregisteredEmitterReverts() public {
        bytes memory payload = Payload.encode(Payload.Message(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 100e18));
        bytes memory forged = signRaw(BASE_SEPOLIA, makeAddr("fakeSpoke"), 0, payload);
        vm.expectRevert(WormholeAdapter.UnknownEmitter.selector);
        adapter.receiveMessage(forged);
    }

    function test_wrongSourceChainReverts() public {
        bytes memory payload = Payload.encode(Payload.Message(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 100e18));
        // Right emitter address, but claimed to come from Ethereum Sepolia where it is not registered.
        bytes memory forged = signRaw(ETH_SEPOLIA, address(spoke), 0, payload);
        vm.expectRevert(WormholeAdapter.UnknownEmitter.selector);
        adapter.receiveMessage(forged);
    }

    function test_badSignatureReverts() public {
        bytes memory vaa = spokeDeposit(alice, weth, 1e18);
        vaa[vaa.length - 1] ^= 0x01; // corrupt the amount
        vm.expectRevert(abi.encodeWithSelector(WormholeAdapter.InvalidVaa.selector, "invalid signature"));
        adapter.receiveMessage(vaa);
    }

    function test_releaseTypeRejectedOnHub() public {
        bytes memory payload = Payload.encode(Payload.Message(Payload.RELEASE, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18));
        bytes memory vaa = signRaw(BASE_SEPOLIA, address(spoke), 99, payload);
        vm.expectRevert(WormholeAdapter.WrongMessageType.selector);
        adapter.receiveMessage(vaa);
    }

    function test_unknownTokenRejected() public {
        bytes memory payload =
            Payload.encode(Payload.Message(Payload.DEPOSIT, 1, Payload.toBytes32(alice), bytes32(uint256(0xBAD)), 1e18));
        vm.expectRevert(WormholeAdapter.UnknownCollateral.selector);
        adapter.receiveMessage(signRaw(BASE_SEPOLIA, address(spoke), 7, payload));
    }

    function test_spokeRejectsUnlistedTokenAndEnforcesCap() public {
        vm.expectRevert(SpokeGateway.TokenNotAllowed.selector);
        spoke.deposit(address(0xBEEF), 1);
        spoke.setToken(address(weth), true, 1e18);
        weth.mint(alice, 2e18);
        vm.startPrank(alice);
        weth.approve(address(spoke), 2e18);
        vm.expectRevert(SpokeGateway.CapExceeded.selector);
        spoke.deposit(address(weth), 2e18);
        vm.stopPrank();
    }

    function test_spokeChargesWormholeFee() public {
        DevWormhole paid = new DevWormhole(BASE_SEPOLIA, vm.addr(GUARDIAN_PK), 0.001 ether);
        SpokeGateway s = new SpokeGateway(paid, MEZO_CHAIN, 1, address(this));
        s.setToken(address(weth), true, type(uint256).max);
        s.setHubEmitter(Payload.toBytes32(address(adapter)));
        weth.mint(alice, 1e18);
        vm.deal(alice, 1 ether);
        vm.startPrank(alice);
        weth.approve(address(s), 1e18);
        vm.expectRevert(SpokeGateway.WrongFee.selector);
        s.deposit(address(weth), 1e18);
        s.deposit{value: 0.001 ether}(address(weth), 1e18);
        vm.stopPrank();
    }

    // --- Hub -> Spoke ----------------------------------------------------------

    function _creditedAlice(uint256 amount) internal {
        adapter.receiveMessage(spokeDeposit(alice, weth, amount));
    }

    function test_withdrawRemoteReleasesOnSpoke() public {
        _creditedAlice(2e18);
        address recipient = makeAddr("aliceOnBase");
        vm.recordLogs();
        vm.prank(alice);
        vaultManager.withdrawRemote(wethBase, 0.5e18, Payload.toBytes32(recipient), noUpdates());
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1.5e18); // debited before release
        bytes memory vaa = signLast(MEZO_CHAIN, address(adapter));

        spoke.receiveMessage(vaa);
        assertEq(weth.balanceOf(recipient), 0.5e18);
        assertEq(spoke.locked(address(weth)), 1.5e18);

        vm.expectRevert(SpokeGateway.AlreadyConsumed.selector);
        spoke.receiveMessage(vaa);
    }

    function test_withdrawRemoteRespectsBorrowLimit() public {
        _creditedAlice(1e18); // $3,200 → limit $2,400
        vm.startPrank(alice);
        vaultManager.borrow(musdMarket, 2_000e18, noUpdates());
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.withdrawRemote(wethBase, 0.5e18, Payload.toBytes32(alice), noUpdates());
        vm.stopPrank();
    }

    function test_spokeRejectsReleaseFromNonHubEmitter() public {
        bytes memory payload = Payload.encode(Payload.Message(Payload.RELEASE, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18));
        vm.expectRevert(SpokeGateway.UnknownEmitter.selector);
        spoke.receiveMessage(signRaw(MEZO_CHAIN, makeAddr("evilHub"), 0, payload));
    }

    function test_spokeRejectsDepositTypeMessages() public {
        bytes memory payload = Payload.encode(Payload.Message(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18));
        vm.expectRevert(SpokeGateway.WrongMessageType.selector);
        spoke.receiveMessage(signRaw(MEZO_CHAIN, address(adapter), 0, payload));
    }

    function test_onlyVaultManagerSendsRelease() public {
        vm.expectRevert(WormholeAdapter.NotVaultManager.selector);
        adapter.sendRelease(BASE_SEPOLIA, SPOKE_WETH, Payload.toBytes32(alice), 1);
    }

    function test_remoteLiquidationReleasesToLiquidatorOnSpoke() public {
        _creditedAlice(1e18);
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 2_350e18, noUpdates());
        ethPrice = 2_800e8; // HF = 2,800 × 0.8 / 2,350 ≈ 0.95
        pushPrices();

        musd.mint(liquidator, 10_000e18);
        address liquidatorOnBase = makeAddr("liquidatorOnBase");
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vm.recordLogs();
        uint256 seized = vaultManager.liquidate(
            alice, musdMarket, 1_000e18, wethBase, 0, address(0), Payload.toBytes32(liquidatorOnBase), noUpdates()
        );
        vm.stopPrank();
        // 1,000 MUSD × 1.07 bonus / $2,800
        assertApproxEqRel(seized, uint256(1_070e18) * 1e8 / 2_800e8, 1e12);

        spoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));
        assertEq(weth.balanceOf(liquidatorOnBase), seized);
        assertEq(spoke.locked(address(weth)), 1e18 - seized);
    }

    function testFuzz_hubCreditNeverExceedsSpokeLocked(uint96 deposit, uint96 withdraw) public {
        deposit = uint96(bound(deposit, 1, 1_000e18));
        withdraw = uint96(bound(withdraw, 1, deposit));
        _creditedAlice(deposit);
        vm.recordLogs();
        vm.prank(alice);
        vaultManager.withdrawRemote(wethBase, withdraw, Payload.toBytes32(alice), noUpdates());
        // In flight: hub already debited, spoke still locked.
        assertLe(vaultManager.totalCollateral(wethBase), spoke.locked(address(weth)));
        spoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));
        assertEq(vaultManager.totalCollateral(wethBase), spoke.locked(address(weth)));
    }
}
