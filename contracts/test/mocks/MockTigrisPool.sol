// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITigrisPool, ITigrisPoolCallee} from "../../src/interfaces/ITigrisPool.sol";

/// @notice Volatile (x·y = k) Tigris pool with the real swap semantics: optimistic transfer, `hook` callback,
///         fee on the input moved out of the pool, then the invariant check against the old reserves.
contract MockTigrisPool is ITigrisPool {
    using SafeERC20 for IERC20;

    /// Where swap fees go (Tigris moves them to a PoolFees contract).
    address public constant FEE_SINK = address(0xFEE5);

    address public immutable token0;
    address public immutable token1;
    bool public constant stable = false;
    /// Fee on the input, in basis points of 10,000 (Tigris testnet MUSD/BTC: 4).
    uint256 public feeBps;
    uint256 public reserve0;
    uint256 public reserve1;
    bool private _locked;

    error K();
    error InsufficientLiquidity();
    error InsufficientInputAmount();
    error InsufficientOutputAmount();
    error InvalidTo();
    error Reentrancy();

    constructor(address tokenA, address tokenB, uint256 feeBps_) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        feeBps = feeBps_;
    }

    /// Adopts the current balances as reserves (seed liquidity by transferring tokens in, then sync).
    function sync() external {
        reserve0 = IERC20(token0).balanceOf(address(this));
        reserve1 = IERC20(token1).balanceOf(address(this));
    }

    function getReserves() external view returns (uint256, uint256, uint256) {
        return (reserve0, reserve1, block.timestamp);
    }

    function getAmountOut(uint256 amountIn, address tokenIn) public view returns (uint256) {
        amountIn -= amountIn * feeBps / 10_000;
        (uint256 reserveA, uint256 reserveB) = tokenIn == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
        return amountIn * reserveB / (reserveA + amountIn);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {
        if (_locked) revert Reentrancy();
        _locked = true;
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutputAmount();
        (uint256 r0, uint256 r1) = (reserve0, reserve1);
        if (amount0Out >= r0 || amount1Out >= r1) revert InsufficientLiquidity();
        if (to == token0 || to == token1) revert InvalidTo();
        if (amount0Out > 0) IERC20(token0).safeTransfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).safeTransfer(to, amount1Out);
        if (data.length > 0) ITigrisPoolCallee(to).hook(msg.sender, amount0Out, amount1Out, data);

        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - amount0Out ? b0 - (r0 - amount0Out) : 0;
        uint256 in1 = b1 > r1 - amount1Out ? b1 - (r1 - amount1Out) : 0;
        if (in0 == 0 && in1 == 0) revert InsufficientInputAmount();
        if (in0 > 0) IERC20(token0).safeTransfer(FEE_SINK, in0 * feeBps / 10_000);
        if (in1 > 0) IERC20(token1).safeTransfer(FEE_SINK, in1 * feeBps / 10_000);
        b0 = IERC20(token0).balanceOf(address(this));
        b1 = IERC20(token1).balanceOf(address(this));
        if (b0 * b1 < r0 * r1) revert K();
        (reserve0, reserve1) = (b0, b1);
        _locked = false;
    }
}
