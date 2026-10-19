// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The part of Mezo's Tigris DEX router (Velodrome v2 style) that Mezodot uses.
/// @dev mezo-org/tigris solidity/contracts/interfaces/IRouter.sol; testnet router 0x9a1f…D7E9.
interface ITigrisRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, Route[] memory routes) external view returns (uint256[] memory amounts);
}
