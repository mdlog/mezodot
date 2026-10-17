// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library WadMath {
    /// @dev Scales `value × 10^expo` to 18 decimals.
    function fromExpo(uint256 value, int256 expo) internal pure returns (uint256) {
        int256 shift = 18 + expo;
        if (shift >= 0) return value * 10 ** uint256(shift);
        return value / 10 ** uint256(-shift);
    }

    /// @dev Scales a fixed-point value with `decimals` decimals to 18 decimals.
    function fromDecimals(uint256 value, uint256 decimals) internal pure returns (uint256) {
        return fromExpo(value, -int256(decimals));
    }
}
