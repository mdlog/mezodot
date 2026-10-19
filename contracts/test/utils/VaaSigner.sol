// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Builds VAA v1 bytes signed by a single dev guardian (tests and devnet scripts).
library VaaSigner {
    uint32 internal constant TIMESTAMP = 1_700_000_000;

    function body(uint16 emitterChain, bytes32 emitter, uint64 sequence, bytes memory payload)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(TIMESTAMP, uint32(0), emitterChain, emitter, sequence, uint8(1), payload);
    }

    function digest(uint32, uint16 emitterChain, bytes32 emitter, uint64 sequence, bytes memory payload)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(keccak256(body(emitterChain, emitter, sequence, payload))));
    }

    function sign(
        Vm vm,
        uint256 guardianKey,
        uint32 guardianSetIndex,
        uint16 emitterChain,
        bytes32 emitter,
        uint64 sequence,
        bytes memory payload
    ) internal pure returns (bytes memory) {
        bytes memory b = body(emitterChain, emitter, sequence, payload);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(guardianKey, keccak256(abi.encodePacked(keccak256(b))));
        return abi.encodePacked(uint8(1), guardianSetIndex, uint8(1), uint8(0), r, s, v - 27, b);
    }
}
