// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Payload} from "../src/libraries/Payload.sol";

/// External wrapper so library reverts can be asserted with vm.expectRevert.
contract PayloadHarness {
    function encode(Payload.Message memory m) external pure returns (bytes memory) {
        return Payload.encode(m);
    }

    function decode(bytes memory data) external pure returns (Payload.Message memory) {
        return Payload.decode(data);
    }
}

contract PayloadTest is Test {
    PayloadHarness internal h = new PayloadHarness();

    function testFuzz_roundTrip(
        uint8 msgType,
        uint64 nonce,
        uint16 targetChain,
        bytes32 target,
        bytes32 account,
        bytes32 token,
        uint256 amount
    ) public view {
        msgType = uint8(bound(msgType, 1, 2));
        Payload.Message memory m = Payload.Message(msgType, nonce, targetChain, target, account, token, amount);
        bytes memory encoded = h.encode(m);
        assertEq(encoded.length, Payload.LENGTH);
        Payload.Message memory d = h.decode(encoded);
        assertEq(d.msgType, msgType);
        assertEq(d.nonce, nonce);
        assertEq(d.targetChain, targetChain);
        assertEq(d.target, target);
        assertEq(d.account, account);
        assertEq(d.token, token);
        assertEq(d.amount, amount);
    }

    function test_layoutIsPacked() public view {
        bytes memory encoded = h.encode(
            Payload.Message(
                Payload.DEPOSIT, 7, 0x2711, bytes32(uint256(9)), bytes32(uint256(1)), bytes32(uint256(2)), 3
            )
        );
        assertEq(encoded.length, 140);
        assertEq(uint8(encoded[0]), Payload.VERSION);
        assertEq(uint8(encoded[0]), 2);
        assertEq(uint8(encoded[1]), Payload.DEPOSIT);
        assertEq(uint8(encoded[9]), 7); // last byte of uint64 nonce
        assertEq(uint8(encoded[10]), 0x27); // targetChain big-endian
        assertEq(uint8(encoded[11]), 0x11);
        assertEq(uint8(encoded[43]), 9); // last byte of target
        assertEq(uint8(encoded[139]), 3); // last byte of amount
    }

    function test_revertsOnWrongLength() public {
        vm.expectRevert(Payload.InvalidPayload.selector);
        h.decode(new bytes(139));
        vm.expectRevert(Payload.InvalidPayload.selector);
        h.decode(new bytes(106)); // v1 length
    }

    function test_revertsOnWrongVersion() public {
        bytes memory encoded = h.encode(Payload.Message(Payload.DEPOSIT, 1, 50, 0, 0, 0, 1));
        encoded[0] = 0x01;
        vm.expectRevert(Payload.InvalidPayload.selector);
        h.decode(encoded);
    }

    function test_revertsOnUnknownType() public {
        bytes memory encoded = h.encode(Payload.Message(Payload.DEPOSIT, 1, 50, 0, 0, 0, 1));
        encoded[1] = 0x09;
        vm.expectRevert(Payload.InvalidPayload.selector);
        h.decode(encoded);
    }
}
