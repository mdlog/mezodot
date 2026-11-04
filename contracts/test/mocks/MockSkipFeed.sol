// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Stands in for Mezo's Skip price precompile, a Chainlink-style aggregator.
contract MockSkipFeed {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;
    bool public broken;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "skip: down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
