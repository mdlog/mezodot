// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITigrisRouter} from "../../src/interfaces/ITigrisRouter.sol";
import {ITigrisPoolFactory} from "../../src/interfaces/ITigrisPool.sol";
import {MockTigrisPool} from "./MockTigrisPool.sol";

/// @notice Single-pool stand-in for the Tigris router and factory: quotes and swaps one hop through the pool
///         exactly as the real router does (pay the pool, then `swap` with no callback).
contract MockTigrisRouter is ITigrisRouter, ITigrisPoolFactory {
    using SafeERC20 for IERC20;

    MockTigrisPool public immutable pool;

    constructor(MockTigrisPool pool_) {
        pool = pool_;
    }

    function getPool(address tokenA, address tokenB, bool stable) external view returns (address) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return !stable && t0 == pool.token0() && t1 == pool.token1() ? address(pool) : address(0);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "Router: EXPIRED");
        amounts = getAmountsOut(amountIn, routes);
        require(amounts[1] >= amountOutMin, "Router: INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(routes[0].from).safeTransferFrom(msg.sender, address(pool), amountIn);
        (uint256 out0, uint256 out1) = routes[0].from == pool.token0() ? (uint256(0), amounts[1]) : (amounts[1], 0);
        pool.swap(out0, out1, to, "");
    }

    function getAmountsOut(uint256 amountIn, Route[] memory routes) public view returns (uint256[] memory amounts) {
        require(routes.length == 1 && !routes[0].stable, "Router: one volatile hop only");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = pool.getAmountOut(amountIn, routes[0].from);
    }
}
