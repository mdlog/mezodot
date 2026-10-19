// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IPriceSource
/// @notice One oracle vendor behind OracleRouter. Sources are trusted, owner-registered adapters that
///         normalise vendor data to WAD (1e18 = $1). Freshness and confidence policy live in the router.
interface IPriceSource {
    /// @return fee Native fee (BTC wei on Mezo) needed to apply `payload` with `update`.
    function updateFee(bytes calldata payload) external view returns (uint256 fee);

    /// @notice Verifies a signed vendor update and stores it (pull model). Reverts on invalid data.
    function update(bytes calldata payload) external payable;

    /// @notice Last stored value for vendor feed `id`. Must not revert: a missing feed returns zeros.
    /// @return priceWad USD price, 18 decimals.
    /// @return confWad Confidence interval in WAD (0 when the vendor publishes none).
    /// @return publishTime Unix seconds at which the vendor published the price.
    function latest(bytes32 id) external view returns (uint256 priceWad, uint256 confWad, uint256 publishTime);
}
