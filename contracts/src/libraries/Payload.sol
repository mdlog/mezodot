// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Payload
/// @notice Wire format for Mezodot cross-chain messages carried by Wormhole.
/// @dev Packed layout (106 bytes):
///      version (1) | msgType (1) | nonce (8) | account (32) | token (32) | amount (32)
///      `account` and `token` are left-padded EVM addresses (Wormhole universal address format).
library Payload {
    uint8 internal constant VERSION = 1;
    /// Spoke -> Hub: collateral was locked in a SpokeGateway.
    uint8 internal constant DEPOSIT = 1;
    /// Hub -> Spoke: release collateral to `account` on the spoke.
    uint8 internal constant RELEASE = 2;

    uint256 internal constant LENGTH = 106;

    error InvalidPayload();

    struct Message {
        uint8 msgType;
        uint64 nonce;
        bytes32 account;
        bytes32 token;
        uint256 amount;
    }

    function encode(Message memory m) internal pure returns (bytes memory) {
        return abi.encodePacked(VERSION, m.msgType, m.nonce, m.account, m.token, m.amount);
    }

    function decode(bytes memory data) internal pure returns (Message memory m) {
        if (data.length != LENGTH) revert InvalidPayload();
        uint8 version;
        uint8 msgType;
        uint64 nonce;
        bytes32 account;
        bytes32 token;
        uint256 amount;
        // mload reads 32 bytes; shift right to extract the narrow leading fields.
        assembly ("memory-safe") {
            let ptr := add(data, 32)
            version := shr(248, mload(ptr))
            msgType := shr(248, mload(add(ptr, 1)))
            nonce := shr(192, mload(add(ptr, 2)))
            account := mload(add(ptr, 10))
            token := mload(add(ptr, 42))
            amount := mload(add(ptr, 74))
        }
        if (version != VERSION || (msgType != DEPOSIT && msgType != RELEASE)) revert InvalidPayload();
        m = Message(msgType, nonce, account, token, amount);
    }

    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    /// @dev Reverts if the upper 12 bytes are non-zero (not an EVM address).
    function toAddress(bytes32 b) internal pure returns (address) {
        if (uint256(b) >> 160 != 0) revert InvalidPayload();
        return address(uint160(uint256(b)));
    }
}
