// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISupraOraclePull} from "../../src/oracle/SupraSource.sol";

/// @notice Tests and local devnet only: stand-in for Supra's SupraOraclePull. A "proof" is
///         abi.encode(pairs, prices, timestampsMs, decimals); committee signatures are not modelled.
///         Mirrors the real contract's 15 s future-timestamp allowance and its lack of a maximum age.
contract MockSupraPull is ISupraOraclePull {
    error DataNotVerified();
    error IncorrectFutureUpdate();

    bool public rejectAll;

    function setRejectAll(bool v) external {
        rejectAll = v;
    }

    function encode(uint256 pair, uint256 price, uint256 timestampMs, uint256 decimals)
        external
        pure
        returns (bytes memory)
    {
        uint256[] memory a = new uint256[](1);
        uint256[] memory b = new uint256[](1);
        uint256[] memory c = new uint256[](1);
        uint256[] memory d = new uint256[](1);
        (a[0], b[0], c[0], d[0]) = (pair, price, timestampMs, decimals);
        return abi.encode(a, b, c, d);
    }

    function verifyOracleProofV2(bytes calldata proof) external view returns (PriceInfo memory info) {
        if (rejectAll) revert DataNotVerified();
        (info.pairs, info.prices, info.timestamp, info.decimal) =
            abi.decode(proof, (uint256[], uint256[], uint256[], uint256[]));
        if (
            info.prices.length != info.pairs.length || info.timestamp.length != info.pairs.length
                || info.decimal.length != info.pairs.length
        ) revert DataNotVerified();
        info.round = info.timestamp;
        for (uint256 i = 0; i < info.timestamp.length; i++) {
            if (info.timestamp[i] > block.timestamp * 1000 + 15_000) revert IncorrectFutureUpdate();
        }
    }
}
