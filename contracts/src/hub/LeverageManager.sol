// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {PToken} from "./PToken.sol";
import {VaultManager} from "./VaultManager.sol";

/// @title LeverageManager
/// @notice 1-click MUSD → pMUSD supply loop in a single transaction using the pool's own flash loan:
///         flash borrow → supply → post pMUSD as collateral → borrow against it → repay flash.
///         `unwind` nets the debt against the posted pMUSD inside the pool (VaultManager.repayWithCollateral),
///         so it needs no flash loan or idle cash. VaultManager enforces LTV, so an over-levered loop reverts.
///         Supply and debt are in the same pool, so the loop's carry is negative by construction (suppliers
///         earn borrow rate × utilisation × (1 − reserve factor)); it exists for transparent leverage, not yield.
/// @dev Users must approve MUSD to this contract and `VaultManager.setOperator(this, true)`.
///      Holds no funds between transactions.
contract LeverageManager is IERC3156FlashBorrower, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    bytes32 internal constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");
    /// Hard ceiling as a sanity bound; the real limit is the collateral LTV (80% ⇒ 5×).
    uint256 public constant MAX_LEVERAGE = 10e18;

    VaultManager public immutable vaultManager;
    PToken public immutable pool;
    IERC20 public immutable asset;
    uint256 public immutable marketId;
    uint256 public immutable collateralId;

    /// Set only for the duration of our own flash loan, so callbacks cannot be triggered externally.
    bool private _inFlash;
    uint256 private _lastShares;

    event Looped(address indexed account, uint256 principal, uint256 leverage, uint256 shares, uint256 debt);
    /// @param repaid Debt repaid with posted pMUSD; @param shares pMUSD withdrawn after that;
    /// @param out MUSD paid out; @param sharesReturned pMUSD returned because the pool lacked the cash for them.
    event Unwound(address indexed account, uint256 repaid, uint256 shares, uint256 out, uint256 sharesReturned);

    error InvalidLeverage();
    error SlippageExceeded();
    error UnauthorizedCallback();
    error ZeroAmount();
    error InvalidConfig();
    error RefundFailed();

    constructor(VaultManager vaultManager_, PToken pool_, uint256 marketId_, uint256 collateralId_) {
        vaultManager = vaultManager_;
        pool = pool_;
        asset = IERC20(pool_.asset());
        marketId = marketId_;
        collateralId = collateralId_;
        // The ids must name this pool's market and its own shares as hub collateral.
        VaultManager.CollateralConfig memory c = vaultManager_.collaterals(collateralId_);
        if (
            address(vaultManager_.markets(marketId_).pool) != address(pool_) || c.isRemote || !c.isShare
                || c.token != address(pool_)
        ) revert InvalidConfig();
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
        _flash(flashAmount, abi.encode(msg.sender, principal, minShares));
        shares = _lastShares;
        debt = flashAmount + fee;
        emit Looped(msg.sender, principal, leverage, shares, debt);
        _refund(spent);
    }

    /// @param repayAmount Debt to repay with posted pMUSD; `type(uint256).max` repays all debt in this market,
    ///        0 repays nothing (withdraw only).
    /// @param shares pMUSD to withdraw after the repayment; `type(uint256).max` withdraws all that is left.
    /// @param minOut Minimum equity returned to the caller, in MUSD: cash paid out plus returned pMUSD at its
    ///        redemption value.
    /// @return out MUSD paid out.
    /// @return sharesReturned pMUSD returned instead of MUSD because the pool's idle cash could not pay them.
    function unwind(uint256 repayAmount, uint256 shares, uint256 minOut, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 out, uint256 sharesReturned)
    {
        uint256 spent = _pushPrices(priceUpdate);
        // Netting debt against pMUSD burns both inside the pool: no flash loan, no fee, no idle cash needed.
        uint256 repaid;
        if (repayAmount > 0 && pool.borrowBalanceCurrent(msg.sender) > 0) {
            (repaid,) = vaultManager.repayWithCollateral(msg.sender, marketId, collateralId, repayAmount);
        }
        if (shares == type(uint256).max) shares = vaultManager.collateralBalance(msg.sender, collateralId);
        if (shares == 0 && repaid == 0) revert ZeroAmount();
        if (shares > 0) {
            // Reverts if the remaining position would exceed its borrow limit.
            vaultManager.withdrawCollateralFor(msg.sender, collateralId, shares, address(this), new bytes[](0));
            // Redeem what idle cash can pay; the rest of the equity stays in pMUSD, still earning.
            uint256 redeemed = Math.min(shares, pool.maxRedeem(address(this)));
            if (redeemed > 0) out = pool.redeem(redeemed, msg.sender, address(this));
            sharesReturned = shares - redeemed;
            if (sharesReturned > 0) IERC20(address(pool)).safeTransfer(msg.sender, sharesReturned);
        }
        if (out + pool.convertToAssets(sharesReturned) < minOut) revert SlippageExceeded();
        emit Unwound(msg.sender, repaid, shares, out, sharesReturned);
        _refund(spent);
    }

    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (!_inFlash || msg.sender != address(pool) || initiator != address(this) || token != address(asset)) {
            revert UnauthorizedCallback();
        }
        (address account, uint256 principal, uint256 minShares) = abi.decode(data, (address, uint256, uint256));
        _onLoop(account, amount, fee, principal, minShares);
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
