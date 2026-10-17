// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Payload
/// @notice Wire format for Mezodot cross-chain messages carried by Wormhole.
/// @dev Packed layout, version 2 (140 bytes):
///      version (1) | msgType (1) | nonce (8) | targetChain (2) | target (32) | account (32) | token (32) | amount (32)
///      `targetChain`/`target` bind a message to the one contract allowed to execute it (Wormhole chain id
///      and universal address), so a VAA cannot be replayed into a re-deployed or different gateway.
///      `target`, `account` and `token` are left-padded EVM addresses (Wormhole universal address format).
library Payload {
    uint8 internal constant VERSION = 2;
    /// Spoke -> Hub: collateral was locked in a SpokeGateway.
    uint8 internal constant DEPOSIT = 1;
    /// Hub -> Spoke: release collateral to `account` on the spoke.
    uint8 internal constant RELEASE = 2;

    uint256 internal constant LENGTH = 140;

    error InvalidPayload();

    struct Message {
        uint8 msgType;
        uint64 nonce;
        uint16 targetChain;
        bytes32 target;
        bytes32 account;
        bytes32 token;
        uint256 amount;
    }

    function encode(Message memory m) internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION, m.msgType, m.nonce, m.targetChain, m.target, m.account, m.token, m.amount);
    }

    function decode(bytes memory data) internal pure returns (Message memory m) {
        if (data.length != LENGTH) revert InvalidPayload();
        uint8 version;
        uint8 msgType;
        uint64 nonce;
        uint16 targetChain;
        bytes32 target;
        bytes32 account;
        bytes32 token;
        uint256 amount;
        // mload reads 32 bytes; shift right to extract the narrow leading fields.
        assembly ("memory-safe") {
            let ptr := add(data, 32)
            version := shr(248, mload(ptr))
            msgType := shr(248, mload(add(ptr, 1)))
            nonce := shr(192, mload(add(ptr, 2)))
            targetChain := shr(240, mload(add(ptr, 10)))
            target := mload(add(ptr, 12))
            account := mload(add(ptr, 44))
            token := mload(add(ptr, 76))
            amount := mload(add(ptr, 108))
        }
        if (version != VERSION || (msgType != DEPOSIT && msgType != RELEASE)) revert InvalidPayload();
        m = Message(msgType, nonce, targetChain, target, account, token, amount);
    }

    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev True if `b` is a left-padded EVM address (upper 12 bytes zero).
    function isAddress(bytes32 b) internal pure returns (bool) {
        return uint256(b) >> 160 == 0;
    }

    /// @dev Reverts if the upper 12 bytes are non-zero (not an EVM address).
    function toAddress(bytes32 b) internal pure returns (address) {
        if (!isAddress(b)) revert InvalidPayload();
        return address(uint160(uint256(b)));
    }
}
