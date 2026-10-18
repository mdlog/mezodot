// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The parts of a Tigris (Velodrome v2 style) pool used for flash swaps.
/// @dev `swap` sends the requested output first, calls `hook` on `to` when `data` is non-empty, then
///      requires the pool to have been paid: its invariant must hold after the fee on the input is taken.
interface ITigrisPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
    /// Output for `amountIn` of `tokenIn` at the current reserves, net of the pool's fee.
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface ITigrisPoolCallee {
    /// @param sender Caller of `swap`.
    /// @param amount0 Token0 the pool sent before the callback.
    /// @param amount1 Token1 the pool sent before the callback.
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external;
}

interface ITigrisPoolFactory {
    /// Pool created by this factory for the pair and curve; zero when there is none.
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
}
