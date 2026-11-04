// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The observation side of a Tigris (Velodrome v2 style) pool: reserves accumulate over time, and a new
///         observation is stored by the first reserve change at least `PERIOD` after the last one.
contract MockTwapPool {
    struct Observation {
        uint256 timestamp;
        uint256 reserve0Cumulative;
        uint256 reserve1Cumulative;
    }

    uint256 internal constant PERIOD = 1800;

    address public immutable token0;
    address public immutable token1;
    uint256 internal reserve0;
    uint256 internal reserve1;
    uint256 internal cumulative0;
    uint256 internal cumulative1;
    uint256 internal lastUpdate;
    Observation[] public observations;

    constructor(address token0_, address token1_, uint256 reserve0_, uint256 reserve1_) {
        token0 = token0_;
        token1 = token1_;
        reserve0 = reserve0_;
        reserve1 = reserve1_;
        lastUpdate = block.timestamp;
        observations.push(Observation(block.timestamp, 0, 0));
    }

    /// Changes the reserves, as a swap would.
    function setReserves(uint256 reserve0_, uint256 reserve1_) external {
        (cumulative0, cumulative1,) = currentCumulativePrices();
        lastUpdate = block.timestamp;
        if (block.timestamp - lastObservation().timestamp >= PERIOD) {
            observations.push(Observation(block.timestamp, cumulative0, cumulative1));
        }
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function observationLength() external view returns (uint256) {
        return observations.length;
    }

    function lastObservation() public view returns (Observation memory) {
        return observations[observations.length - 1];
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, lastUpdate);
    }

    function currentCumulativePrices() public view returns (uint256, uint256, uint256) {
        uint256 elapsed = block.timestamp - lastUpdate;
        return (cumulative0 + reserve0 * elapsed, cumulative1 + reserve1 * elapsed, block.timestamp);
    }
}
