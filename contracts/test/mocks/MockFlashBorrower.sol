// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {PToken} from "../../src/hub/PToken.sol";

/// @notice ERC-3156 borrower for MezodotPool flash loans. It repays principal plus fee from its own balance, so fund it
///         with the fee before borrowing. It records the pool's share price as seen inside the callback and can supply
///         to and redeem from the same pool while the loan is live (as LeverageManager does).
contract MockFlashBorrower is IERC3156FlashBorrower {
    using SafeERC20 for IERC20;

    bytes32 internal constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    /// Exchange rate of the lending pool at the start of the last callback.
    uint256 public rateDuringLoan;
    /// Fee the pool charged in the last callback.
    uint256 public lastFee;

    error UntrustedInitiator();

    /// @param roundTrip Deposit half of the loan into the pool and redeem those shares inside the callback.
    function borrow(PToken pool, uint256 amount, bool roundTrip) external {
        pool.flashLoan(this, pool.asset(), amount, abi.encode(roundTrip));
    }

    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (initiator != address(this)) revert UntrustedInitiator();
        PToken pool = PToken(msg.sender);
        rateDuringLoan = pool.exchangeRate();
        lastFee = fee;
        if (abi.decode(data, (bool))) {
            IERC20(token).forceApprove(address(pool), amount / 2);
            uint256 shares = pool.deposit(amount / 2, address(this));
            pool.redeem(shares, address(this), address(this));
        }
        IERC20(token).forceApprove(msg.sender, amount + fee);
        return CALLBACK_SUCCESS;
    }
}
