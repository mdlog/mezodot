// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {DevWormhole} from "./mocks/DevWormhole.sol";
import {VaaSigner} from "./utils/VaaSigner.sol";

contract DevWormholeTest is Test {
    uint256 internal constant GUARDIAN_PK = 0xA11CE;
    DevWormhole internal wormhole;

    function setUp() public {
        wormhole = new DevWormhole(50, vm.addr(GUARDIAN_PK), 0);
    }

    function test_publishIncrementsSequencePerEmitter() public {
        assertEq(wormhole.publishMessage(0, hex"01", 1), 0);
        assertEq(wormhole.publishMessage(0, hex"02", 1), 1);
        vm.prank(address(0xBEEF));
        assertEq(wormhole.publishMessage(0, hex"03", 1), 0);
    }

    function test_publishEmitsLogMessagePublished() public {
        vm.expectEmit(true, false, false, true);
        emit IWormhole.LogMessagePublished(address(this), 0, 9, hex"abcd", 1);
        wormhole.publishMessage(9, hex"abcd", 1);
    }

    function test_signedVaaVerifies() public view {
        bytes memory vaa = VaaSigner.sign(vm, GUARDIAN_PK, 0, 10004, bytes32(uint256(0x1234)), 5, hex"cafe");
        (IWormhole.VM memory parsed, bool valid,) = wormhole.parseAndVerifyVM(vaa);
        assertTrue(valid);
        assertEq(parsed.emitterChainId, 10004);
        assertEq(parsed.emitterAddress, bytes32(uint256(0x1234)));
        assertEq(parsed.sequence, 5);
        assertEq(parsed.payload, hex"cafe");
        assertEq(parsed.hash, VaaSigner.digest(0, 10004, bytes32(uint256(0x1234)), 5, hex"cafe"));
    }

    function test_wrongSignerInvalid() public view {
        bytes memory vaa = VaaSigner.sign(vm, 0xB0B, 0, 10004, bytes32(uint256(1)), 0, hex"cafe");
        (, bool valid, string memory reason) = wormhole.parseAndVerifyVM(vaa);
        assertFalse(valid);
        assertEq(reason, "invalid signature");
    }

    function test_tamperedBodyInvalid() public view {
        bytes memory vaa = VaaSigner.sign(vm, GUARDIAN_PK, 0, 10004, bytes32(uint256(1)), 0, hex"cafe");
        vaa[vaa.length - 1] = 0x00; // flip last payload byte
        (, bool valid,) = wormhole.parseAndVerifyVM(vaa);
        assertFalse(valid);
    }

    function test_wrongGuardianSetInvalid() public view {
        bytes memory vaa = VaaSigner.sign(vm, GUARDIAN_PK, 3, 10004, bytes32(uint256(1)), 0, hex"cafe");
        (, bool valid, string memory reason) = wormhole.parseAndVerifyVM(vaa);
        assertFalse(valid);
        assertEq(reason, "invalid guardian set");
    }

    /// Real VAA emitted on Mezo testnet (Wormholescan 50/0e628a…5913/76), signed by the
    /// single testnet guardian. Proves DevWormhole parses the production wire format.
    function test_verifiesRealMezoTestnetVaa() public {
        DevWormhole testnet = new DevWormhole(50, 0x13947Bd48b18E53fdAeEe77F3473391aC727C638, 0);
        bytes memory vaa =
            hex"01000000000100eb902da83dccac5d7421ea5746bfa53e24e6a98f09517be1878046cb43ffb0920f0bc1cb1f335c5e1e8b2d867cb64d39c473665917fa2e8dda3913785245f528006acd25af0000000000320000000000000000000000000e628a1c34c92f0aa85af998814ce4f03caa5913000000000000004cca9945ff1000000000000000000000000020888b20e2f5f405d44261da96467a1b1ace15be0000000000000000000000001ca5060bf142c58168aedb974aabb020bc081a560091000000000000000000000000000000000000000000000000000000000000014d0000000000000000000000008915bfa6d1b83d8769ca15b3367a174b1c8f89a4004f994e54540800000002540be400000000000000000000000000118917a40faf1cd7a13db0ef56c86de7973ac503000000000000000000000000ccc9a4fa3ae1166b42597561a4e7ba099317720e27120000";
        (IWormhole.VM memory parsed, bool valid, string memory reason) = testnet.parseAndVerifyVM(vaa);
        assertTrue(valid, reason);
        assertEq(parsed.emitterChainId, 50);
        assertEq(parsed.emitterAddress, bytes32(0x0000000000000000000000000e628a1c34c92f0aa85af998814ce4f03caa5913));
        assertEq(parsed.sequence, 76);
    }
}
