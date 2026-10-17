// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {PToken} from "./PToken.sol";
import {VaultManager} from "./VaultManager.sol";

/// @title LeverageManager
/// @notice 1-click MUSD → pMUSD yield loop in a single transaction using the pool's own flash loan:
///         flash borrow → supply → post pMUSD as collateral → borrow against it → repay flash.
///         `unwind` reverses it. VaultManager enforces LTV, so an over-levered loop simply reverts.
/// @dev Users must approve MUSD to this contract and `VaultManager.setOperator(this, true)`.
///      Holds no funds between transactions.
contract LeverageManager is IERC3156FlashBorrower, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    bytes32 internal constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");
    /// Hard ceiling as a sanity bound; the real limit is the collateral LTV (80% ⇒ 5×).
    uint256 public constant MAX_LEVERAGE = 10e18;

    enum Action {
        Loop,
        Unwind
    }

    VaultManager public immutable vaultManager;
    PToken public immutable pool;
    IERC20 public immutable asset;
    uint256 public immutable marketId;
    uint256 public immutable collateralId;

    /// Set only for the duration of our own flash loan, so callbacks cannot be triggered externally.
    bool private _inFlash;
    uint256 private _lastShares;
    uint256 private _lastOut;

    event Looped(address indexed account, uint256 principal, uint256 leverage, uint256 shares, uint256 debt);
    event Unwound(address indexed account, uint256 repaid, uint256 shares, uint256 out);

    error InvalidLeverage();
    error SlippageExceeded();
    error UnauthorizedCallback();
    error ZeroAmount();
    error RefundFailed();

    constructor(VaultManager vaultManager_, PToken pool_, uint256 marketId_, uint256 collateralId_) {
        vaultManager = vaultManager_;
        pool = pool_;
        asset = IERC20(pool_.asset());
        marketId = marketId_;
        collateralId = collateralId_;
    }

    /// @param principal User equity in the pool's asset.
    /// @param leverage Target gross exposure / equity (WAD), e.g. 3e18.
    /// @param minShares Minimum pTokens posted as collateral (slippage guard).
    function loop(uint256 principal, uint256 leverage, uint256 minShares, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 shares, uint256 debt)
    {
        if (principal == 0) revert ZeroAmount();
        if (leverage <= WAD || leverage > MAX_LEVERAGE) revert InvalidLeverage();
        uint256 spent = _pushPrices(priceUpdate);
        uint256 flashAmount = principal * (leverage - WAD) / WAD;
        asset.safeTransferFrom(msg.sender, address(this), principal);

        uint256 fee = pool.flashFee(address(asset), flashAmount);
        _flash(flashAmount, abi.encode(Action.Loop, msg.sender, principal, minShares));
        shares = _lastShares;
        debt = flashAmount + fee;
        emit Looped(msg.sender, principal, leverage, shares, debt);
        _refund(spent);
    }

    /// @param repayAmount Debt to repay via flash loan; `type(uint256).max` repays all debt in this market.
    /// @param shares pToken collateral to withdraw; `type(uint256).max` withdraws all of it.
    /// @param minOut Minimum equity returned to the caller.
    function unwind(uint256 repayAmount, uint256 shares, uint256 minOut, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 out)
    {
        uint256 spent = _pushPrices(priceUpdate);
        if (repayAmount == type(uint256).max) repayAmount = pool.borrowBalanceCurrent(msg.sender);
        if (shares == type(uint256).max) shares = vaultManager.collateralBalance(msg.sender, collateralId);
        if (repayAmount == 0 || shares == 0) revert ZeroAmount();

        _flash(repayAmount, abi.encode(Action.Unwind, msg.sender, shares, minOut));
        out = _lastOut;
        emit Unwound(msg.sender, repayAmount, shares, out);
        _refund(spent);
    }

    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (!_inFlash || msg.sender != address(pool) || initiator != address(this) || token != address(asset)) {
            revert UnauthorizedCallback();
        }
        (Action action, address account, uint256 a, uint256 b) = abi.decode(data, (Action, address, uint256, uint256));
        if (action == Action.Loop) _onLoop(account, amount, fee, a, b);
        else _onUnwind(account, amount, fee, a, b);
        asset.forceApprove(address(pool), amount + fee);
        return CALLBACK_SUCCESS;
    }

    function _onLoop(address account, uint256 amount, uint256 fee, uint256 principal, uint256 minShares) internal {
        uint256 total = principal + amount;
        asset.forceApprove(address(pool), total);
        uint256 shares = pool.deposit(total, address(this));
        if (shares < minShares) revert SlippageExceeded();
        IERC20(address(pool)).forceApprove(address(vaultManager), shares);
        vaultManager.depositCollateralFor(account, collateralId, shares);
        // Borrow exactly what the flash loan needs back; VaultManager reverts if this breaks the LTV.
        vaultManager.borrowFor(account, marketId, amount + fee, address(this), new bytes[](0));
        _lastShares = shares;
    }

    function _onUnwind(address account, uint256 amount, uint256 fee, uint256 shares, uint256 minOut) internal {
        asset.forceApprove(address(vaultManager), amount);
        vaultManager.repay(marketId, amount, account);
        // Reverts if the remaining position would exceed its borrow limit.
        vaultManager.withdrawCollateralFor(account, collateralId, shares, address(this), new bytes[](0));
        pool.redeem(shares, address(this), address(this));
        uint256 balance = asset.balanceOf(address(this));
        uint256 owed = amount + fee;
        if (balance < owed) revert SlippageExceeded();
        uint256 out = balance - owed;
        if (out < minOut) revert SlippageExceeded();
        if (out > 0) asset.safeTransfer(account, out);
        _lastOut = out;
    }

    function _flash(uint256 amount, bytes memory data) internal {
        _inFlash = true;
        pool.flashLoan(this, address(asset), amount, data);
        _inFlash = false;
    }

    function _pushPrices(bytes[] calldata updates) internal returns (uint256 fee) {
        if (updates.length == 0) return 0;
        fee = vaultManager.oracle().updateFee(updates);
        vaultManager.oracle().updatePrices{value: fee}(updates);
    }

    function _refund(uint256 spent) internal {
        uint256 refund = msg.value - spent;
        if (refund == 0) return;
        (bool ok,) = msg.sender.call{value: refund}("");
        if (!ok) revert RefundFailed();
    }
}
