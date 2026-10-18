// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITigrisRouter} from "../../src/interfaces/ITigrisRouter.sol";
import {MockERC20} from "./MockERC20.sol";

/// @notice Fixed-rate stand-in for the Tigris router: takes `from`, mints `to` at `rate[from][to]` (WAD).
contract MockTigrisRouter is ITigrisRouter {
    mapping(address from => mapping(address to => uint256 wad)) public rate;

    function setRate(address from, address to, uint256 wad) external {
        rate[from][to] = wad;
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
        IERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(routes[0].to).mint(to, amounts[1]);
    }

    function getAmountsOut(uint256 amountIn, Route[] memory routes) public view returns (uint256[] memory amounts) {
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountIn * rate[routes[0].from][routes[0].to] / 1e18;
    }
}
