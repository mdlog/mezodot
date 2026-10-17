// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title InterestRateModel
/// @notice Kinked ("jump") utilization curve. All inputs are WAD, rates are per year.
///         borrowRate(u) = base + slope1 * u / kink                         for u <= kink
///                       = base + slope1 + slope2 * (u - kink) / (1 - kink)  for u >  kink
contract InterestRateModel {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SECONDS_PER_YEAR = 365 days;

    uint256 public immutable baseRatePerYear;
    uint256 public immutable slope1PerYear;
    uint256 public immutable kink;
    uint256 public immutable slope2PerYear;

    error InvalidParams();

    constructor(uint256 baseRatePerYear_, uint256 slope1PerYear_, uint256 kink_, uint256 slope2PerYear_) {
        if (kink_ == 0 || kink_ >= WAD) revert InvalidParams();
        baseRatePerYear = baseRatePerYear_;
        slope1PerYear = slope1PerYear_;
        kink = kink_;
        slope2PerYear = slope2PerYear_;
    }

    /// @notice borrows / (cash + borrows - reserves); reserves are protocol-owned, not supply.
    function utilization(uint256 cash, uint256 borrows, uint256 reserves) public pure returns (uint256) {
        if (borrows == 0) return 0;
        uint256 supplied = cash + borrows - reserves;
        if (supplied == 0) return WAD;
        uint256 u = borrows * WAD / supplied;
        return u > WAD ? WAD : u;
    }

    function borrowRatePerYear(uint256 cash, uint256 borrows, uint256 reserves) public view returns (uint256) {
        uint256 u = utilization(cash, borrows, reserves);
        if (u <= kink) return baseRatePerYear + slope1PerYear * u / kink;
        return baseRatePerYear + slope1PerYear + slope2PerYear * (u - kink) / (WAD - kink);
    }

    function borrowRatePerSecond(uint256 cash, uint256 borrows, uint256 reserves) external view returns (uint256) {
        return borrowRatePerYear(cash, borrows, reserves) / SECONDS_PER_YEAR;
    }

    /// @notice Rate earned by suppliers: borrowRate × utilization × (1 − reserveFactor).
    function supplyRatePerSecond(uint256 cash, uint256 borrows, uint256 reserves, uint256 reserveFactor)
        external
        view
        returns (uint256)
    {
        uint256 borrowRate = borrowRatePerYear(cash, borrows, reserves) / SECONDS_PER_YEAR;
        uint256 u = utilization(cash, borrows, reserves);
        return borrowRate * u / WAD * (WAD - reserveFactor) / WAD;
    }
}
