// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {CrossChainFixture} from "./utils/CrossChainFixture.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {WormholeAdapter} from "../src/hub/WormholeAdapter.sol";
import {SpokeGateway} from "../src/spoke/SpokeGateway.sol";
import {Payload} from "../src/libraries/Payload.sol";
import {DevWormhole} from "./mocks/DevWormhole.sol";

contract CrossChainTest is CrossChainFixture {
    address internal bob = makeAddr("bob");

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
        bytes memory payload = Payload.encode(hubMsg(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 100e18));
        bytes memory forged = signRaw(BASE_SEPOLIA, makeAddr("fakeSpoke"), 0, payload);
        vm.expectRevert(WormholeAdapter.UnknownEmitter.selector);
        adapter.receiveMessage(forged);
    }

    function test_wrongSourceChainReverts() public {
        bytes memory payload = Payload.encode(hubMsg(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 100e18));
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
        bytes memory payload = Payload.encode(hubMsg(Payload.RELEASE, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18));
        bytes memory vaa = signRaw(BASE_SEPOLIA, address(spoke), 99, payload);
        vm.expectRevert(WormholeAdapter.WrongMessageType.selector);
        adapter.receiveMessage(vaa);
    }

    function test_unknownTokenRejected() public {
        bytes memory payload =
            Payload.encode(hubMsg(Payload.DEPOSIT, 1, Payload.toBytes32(alice), bytes32(uint256(0xBAD)), 1e18));
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
        bytes memory payload = Payload.encode(spokeMsg(Payload.RELEASE, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18));
        vm.expectRevert(SpokeGateway.UnknownEmitter.selector);
        spoke.receiveMessage(signRaw(MEZO_CHAIN, makeAddr("evilHub"), 0, payload));
    }

    function test_spokeRejectsDepositTypeMessages() public {
        bytes memory payload = Payload.encode(spokeMsg(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18));
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

    // --- Destination binding (final review I1 / I2) ---------------------------------

    function _withdrawRemoteVaa(address who, uint256 id, uint256 amount, bytes32 recipient)
        internal
        returns (bytes memory)
    {
        vm.recordLogs();
        vm.prank(who);
        vaultManager.withdrawRemote(id, amount, recipient, noUpdates());
        return signLast(MEZO_CHAIN, address(adapter));
    }

    /// A RELEASE executed on one gateway cannot be replayed into a re-deployed gateway on the same chain.
    function test_releaseRejectedByRedeployedSpoke() public {
        _creditedAlice(10e18);
        bytes memory release = _withdrawRemoteVaa(alice, wethBase, 10e18, Payload.toBytes32(alice));
        spoke.receiveMessage(release);

        SpokeGateway spoke2 = new SpokeGateway(spokeWormhole, MEZO_CHAIN, 1, address(this));
        spoke2.setToken(address(weth), true, type(uint256).max);
        spoke2.setHubEmitter(Payload.toBytes32(address(adapter)));
        adapter.setSpoke(BASE_SEPOLIA, Payload.toBytes32(address(spoke2)));
        weth.mint(bob, 10e18);
        vm.startPrank(bob);
        weth.approve(address(spoke2), 10e18);
        spoke2.deposit(address(weth), 10e18);
        vm.stopPrank();

        vm.expectRevert(SpokeGateway.WrongTarget.selector);
        spoke2.receiveMessage(release);
        assertEq(spoke2.locked(address(weth)), 10e18);
        assertEq(weth.balanceOf(alice), 10e18);
    }

    /// A RELEASE addressed to the Base gateway is rejected by the Ethereum gateway, even for the same token address.
    function test_releaseRejectedByOtherSpoke() public {
        DevWormhole ethWh = new DevWormhole(ETH_SEPOLIA, vm.addr(GUARDIAN_PK), 0);
        SpokeGateway ethSpoke = new SpokeGateway(ethWh, MEZO_CHAIN, 1, address(this));
        ethSpoke.setToken(address(weth), true, type(uint256).max);
        ethSpoke.setHubEmitter(Payload.toBytes32(address(adapter)));
        weth.mint(bob, 10e18);
        vm.startPrank(bob);
        weth.approve(address(ethSpoke), 10e18);
        ethSpoke.deposit(address(weth), 10e18);
        vm.stopPrank();

        _creditedAlice(10e18);
        bytes memory release = _withdrawRemoteVaa(alice, wethBase, 10e18, Payload.toBytes32(alice));
        vm.expectRevert(SpokeGateway.WrongTarget.selector);
        ethSpoke.receiveMessage(release);
        spoke.receiveMessage(release); // still executes at its real destination
        assertEq(weth.balanceOf(alice), 10e18);
        assertEq(ethSpoke.locked(address(weth)), 10e18);
    }

    function test_releaseCarriesItsDestination() public {
        _creditedAlice(1e18);
        vm.recordLogs();
        vm.prank(alice);
        vaultManager.withdrawRemote(wethBase, 1e18, Payload.toBytes32(alice), noUpdates());
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory payload;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IWormhole.LogMessagePublished.selector) {
                (,, payload,) = abi.decode(logs[i].data, (uint64, uint32, bytes, uint8));
            }
        }
        Payload.Message memory m = Payload.decode(payload);
        assertEq(m.targetChain, BASE_SEPOLIA);
        assertEq(m.target, Payload.toBytes32(address(spoke)));
    }

    /// A DEPOSIT addressed to a different hub adapter (or chain) never credits this hub.
    function test_depositAddressedElsewhereRejected() public {
        Payload.Message memory m = hubMsg(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18);
        m.target = Payload.toBytes32(makeAddr("otherAdapter"));
        vm.expectRevert(WormholeAdapter.WrongTarget.selector);
        adapter.receiveMessage(signRaw(BASE_SEPOLIA, address(spoke), 50, Payload.encode(m)));

        m = hubMsg(Payload.DEPOSIT, 1, Payload.toBytes32(alice), SPOKE_WETH, 1e18);
        m.targetChain = ETH_SEPOLIA;
        vm.expectRevert(WormholeAdapter.WrongTarget.selector);
        adapter.receiveMessage(signRaw(BASE_SEPOLIA, address(spoke), 51, Payload.encode(m)));
        assertEq(vaultManager.collateralBalance(alice, wethBase), 0);
    }

    function test_spokeDepositCarriesHubDestination() public {
        weth.mint(alice, 1e18);
        vm.startPrank(alice);
        weth.approve(address(spoke), 1e18);
        vm.recordLogs();
        spoke.deposit(address(weth), 1e18);
        vm.stopPrank();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes memory payload;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == IWormhole.LogMessagePublished.selector) {
                (,, payload,) = abi.decode(logs[i].data, (uint64, uint32, bytes, uint8));
            }
        }
        Payload.Message memory m = Payload.decode(payload);
        assertEq(m.targetChain, MEZO_CHAIN);
        assertEq(m.target, Payload.toBytes32(address(adapter)));
    }

    // --- Recipient validation (final review M5) ---------------------------------------

    function test_withdrawRemoteRejectsMalformedRecipient() public {
        _creditedAlice(1e18);
        bytes32 bad = bytes32(uint256(uint160(alice)) | (uint256(1) << 200));
        vm.prank(alice);
        vm.expectRevert(VaultManager.InvalidRecipient.selector);
        vaultManager.withdrawRemote(wethBase, 1e18, bad, noUpdates());
        // Right-padded address (a common integration mistake) is rejected too.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InvalidRecipient.selector);
        vaultManager.withdrawRemote(wethBase, 1e18, bytes32(bytes20(alice)), noUpdates());
        assertEq(vaultManager.collateralBalance(alice, wethBase), 1e18);
    }

    function test_remoteLiquidationRejectsMalformedReceiver() public {
        _creditedAlice(1e18);
        vm.prank(alice);
        vaultManager.borrow(musdMarket, 2_350e18, noUpdates());
        ethPrice = 2_800e8;
        pushPrices();
        musd.mint(liquidator, 10_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(vaultManager), type(uint256).max);
        vm.expectRevert(VaultManager.InvalidRecipient.selector);
        vaultManager.liquidate(
            alice, musdMarket, 1_000e18, wethBase, 0, address(0), bytes32(bytes20(liquidator)), noUpdates()
        );
        vm.stopPrank();
    }

    /// Final review I3: a debt-free exit from a spoke needs no oracle at all.
    function test_debtFreeRemoteExitNeedsNoFreshPrices() public {
        _creditedAlice(1e18);
        skip(1 days);
        bytes memory release = _withdrawRemoteVaa(alice, wethBase, 1e18, Payload.toBytes32(alice));
        spoke.receiveMessage(release);
        assertEq(weth.balanceOf(alice), 1e18);
    }
}
