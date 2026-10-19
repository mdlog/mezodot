// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IWormhole} from "../../src/interfaces/IWormhole.sol";

/// @title DevWormhole
/// @notice Local stand-in for Wormhole Core with a single guardian.
/// @dev Parses the real VAA v1 wire format and verifies the guardian signature over
///      keccak256(keccak256(body)), so contracts exercise the same code paths as on testnet.
///      Never deploy outside a local devnet.
contract DevWormhole is IWormhole {
    uint16 public immutable override chainId;
    address public immutable guardian;
    uint32 public immutable guardianSetIndex;
    uint256 public override messageFee;

    mapping(address emitter => uint64) public nextSequence;

    constructor(uint16 chainId_, address guardian_, uint256 messageFee_) {
        chainId = chainId_;
        guardian = guardian_;
        guardianSetIndex = 0;
        messageFee = messageFee_;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        override
        returns (uint64 sequence)
    {
        require(msg.value == messageFee, "invalid fee");
        sequence = nextSequence[msg.sender]++;
        emit LogMessagePublished(msg.sender, sequence, nonce, payload, consistencyLevel);
    }

    function parseAndVerifyVM(bytes calldata encoded)
        external
        view
        override
        returns (VM memory vm, bool valid, string memory reason)
    {
        vm = parseVM(encoded);
        if (vm.guardianSetIndex != guardianSetIndex) return (vm, false, "invalid guardian set");
        if (vm.signatures.length != 1 || vm.signatures[0].guardianIndex != 0) return (vm, false, "no quorum");
        Signature memory sig = vm.signatures[0];
        address signer = ecrecover(vm.hash, sig.v, sig.r, sig.s);
        if (signer == address(0) || signer != guardian) return (vm, false, "invalid signature");
        return (vm, true, "");
    }

    /// @dev Layout: version(1) gsIndex(4) sigCount(1) [guardianIndex(1) r(32) s(32) v(1)]* body
    ///      body: timestamp(4) nonce(4) emitterChain(2) emitter(32) sequence(8) consistency(1) payload
    function parseVM(bytes calldata encoded) public pure returns (VM memory vm) {
        uint256 i = 0;
        vm.version = uint8(encoded[i]);
        i += 1;
        vm.guardianSetIndex = uint32(bytes4(encoded[i:i + 4]));
        i += 4;
        uint256 sigCount = uint8(encoded[i]);
        i += 1;
        vm.signatures = new Signature[](sigCount);
        for (uint256 s = 0; s < sigCount; s++) {
            vm.signatures[s].guardianIndex = uint8(encoded[i]);
            vm.signatures[s].r = bytes32(encoded[i + 1:i + 33]);
            vm.signatures[s].s = bytes32(encoded[i + 33:i + 65]);
            // Wormhole stores the recovery id (0/1); ecrecover expects 27/28.
            vm.signatures[s].v = uint8(encoded[i + 65]) + 27;
            i += 66;
        }
        bytes calldata body = encoded[i:];
        vm.hash = keccak256(abi.encodePacked(keccak256(body)));
        vm.timestamp = uint32(bytes4(body[0:4]));
        vm.nonce = uint32(bytes4(body[4:8]));
        vm.emitterChainId = uint16(bytes2(body[8:10]));
        vm.emitterAddress = bytes32(body[10:42]);
        vm.sequence = uint64(bytes8(body[42:50]));
        vm.consistencyLevel = uint8(body[50]);
        vm.payload = body[51:];
    }
}
