// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceSource} from "./IPriceSource.sol";

/// @notice The Chainlink-style read of Mezo's Skip price precompile.
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title SkipSource
/// @notice BTC/USD from Mezo's own price feed: the Skip precompile at 0x7b7c…0015 that MUSD's PriceFeed also reads.
///         Validators write it into the chain, so it needs no API key, no pusher and no proof in the transaction.
/// @dev The feed's decimals are a constructor argument because forge scripts cannot execute the precompile.
contract SkipSource is IPriceSource {
    IAggregatorV3 public immutable feed;
    uint256 internal immutable scale;

    error NoPullUpdates();

    constructor(IAggregatorV3 feed_, uint8 decimals_) {
        feed = feed_;
        scale = 10 ** (18 - uint256(decimals_));
    }

    function updateFee(bytes calldata) external pure returns (uint256) {
        return 0;
    }

    /// @dev Nothing to verify or store: a caller attaching an update for this source has made a mistake.
    function update(bytes calldata) external payable {
        revert NoPullUpdates();
    }

    function latest(bytes32) external view returns (uint256 priceWad, uint256 confWad, uint256 publishTime) {
        try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (0, 0, 0);
            return (uint256(answer) * scale, 0, updatedAt);
        } catch {
            return (0, 0, 0);
        }
    }
}
