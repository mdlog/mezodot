// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PToken} from "./PToken.sol";
import {VaultManager} from "./VaultManager.sol";
import {ITigrisPool, ITigrisPoolCallee} from "../interfaces/ITigrisPool.sol";

/// @title SwapLeverageManager
/// @notice One-transaction leverage on a plain hub collateral (Mezo's BTC) against debt in the MUSD market,
///         built on a flash swap from the Tigris MUSD/collateral pool (the pool pays out first and checks it was
///         paid after our callback):
///         open:  take collateral from the pool → post principal + bought collateral → borrow MUSD straight
///                to the pool as its payment.
///         close: take MUSD from the pool → repay the debt → withdraw collateral → pay the pool in collateral →
///                return the remaining collateral and MUSD to the owner.
///         The MUSD market only lends the debt itself (no flash loan on top), so leverage needs no spare pool
///         cash and pays no flash fee. VaultManager enforces LTV and health on every step, so an over-levered
///         position simply reverts.
/// @dev Users approve the collateral to this contract and call `VaultManager.setOperator(this, true)`.
///      Swap amounts come from the pool's own quote at execution; callers bound them with minimums computed
///      off-chain. Holds no funds between transactions.
contract SwapLeverageManager is ITigrisPoolCallee, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Action {
        Open,
        Close
    }

    VaultManager public immutable vaultManager;
    /// MUSD lending pool: the debt market.
    PToken public immutable pool;
    IERC20 public immutable debtAsset;
    IERC20 public immutable collateral;
    uint256 public immutable marketId;
    uint256 public immutable collateralId;
    /// Tigris pool holding the debt asset and the collateral.
    ITigrisPool public immutable pair;
    bool internal immutable collateralIsToken0;

    /// Set only while our own swap runs, so the callback cannot be triggered externally.
    bool private _inSwap;

    event Opened(address indexed account, uint256 principal, uint256 borrowed, uint256 bought, uint256 debt);
    event Closed(
        address indexed account,
        uint256 repaid,
        uint256 withdrawn,
        uint256 sold,
        uint256 collateralOut,
        uint256 debtAssetOut
    );

    error ZeroAmount();
    error Expired();
    error SlippageExceeded();
    error UnauthorizedCallback();
    error RefundFailed();
    error InvalidPair();
    error InvalidConfig();

    constructor(VaultManager vaultManager_, PToken pool_, uint256 marketId_, uint256 collateralId_, ITigrisPool pair_) {
        vaultManager = vaultManager_;
        pool = pool_;
        debtAsset = IERC20(pool_.asset());
        marketId = marketId_;
        collateralId = collateralId_;
        collateral = IERC20(vaultManager_.collaterals(collateralId_).token);
        pair = pair_;
        // The ids must name this pool's market and a plain token held on the hub.
        VaultManager.CollateralConfig memory c = vaultManager_.collaterals(collateralId_);
        if (address(vaultManager_.markets(marketId_).pool) != address(pool_) || c.isRemote || c.isShare) {
            revert InvalidConfig();
        }
        (address token0, address token1) = (pair_.token0(), pair_.token1());
        bool ordered = token0 == address(collateral) && token1 == address(debtAsset);
        if (!ordered && !(token0 == address(debtAsset) && token1 == address(collateral))) revert InvalidPair();
        collateralIsToken0 = ordered;
    }

    /// @param principal Collateral the caller adds from their wallet.
    /// @param borrowAmount MUSD borrowed and swapped into collateral; it becomes the position's debt.
    /// @param minBought Minimum collateral the swap must return (slippage guard).
    function open(
        uint256 principal,
        uint256 borrowAmount,
        uint256 minBought,
        uint256 deadline,
        bytes[] calldata priceUpdate
    ) external payable nonReentrant returns (uint256 posted, uint256 debt) {
        if (principal == 0 || borrowAmount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert Expired();
        uint256 spent = _pushPrices(priceUpdate);
        collateral.safeTransferFrom(msg.sender, address(this), principal);

        // What the pool's invariant allows for `borrowAmount` at its current reserves and fee.
        uint256 bought = pair.getAmountOut(borrowAmount, address(debtAsset));
        if (bought == 0 || bought < minBought) revert SlippageExceeded();
        _flashSwap(collateralIsToken0, bought, abi.encode(Action.Open, msg.sender, principal, borrowAmount));
        posted = principal + bought;
        debt = borrowAmount;
        emit Opened(msg.sender, principal, borrowAmount, bought, debt);
        _refund(spent);
    }

    /// @param repayAmount MUSD debt to repay, capped at the live debt; `type(uint256).max` repays all of it.
    /// @param withdrawAmount Collateral to withdraw; `type(uint256).max` withdraws all of it.
    /// @param sellAmount Part of the withdrawn collateral sold for MUSD to fund the repayment.
    /// @param minProceeds Minimum MUSD the sale must return; it must at least cover the repayment.
    function close(
        uint256 repayAmount,
        uint256 withdrawAmount,
        uint256 sellAmount,
        uint256 minProceeds,
        uint256 deadline,
        bytes[] calldata priceUpdate
    ) external payable nonReentrant returns (uint256 collateralOut, uint256 debtAssetOut) {
        if (block.timestamp > deadline) revert Expired();
        uint256 spent = _pushPrices(priceUpdate);
        // Never more than the live debt: a liquidation or third-party repay may land first, and any excess
        // would otherwise be sold for and then left in this contract.
        uint256 owed = pool.borrowBalanceCurrent(msg.sender);
        if (repayAmount > owed) repayAmount = owed;
        if (withdrawAmount == type(uint256).max) {
            withdrawAmount = vaultManager.collateralBalance(msg.sender, collateralId);
        }
        if (repayAmount == 0 || withdrawAmount == 0 || sellAmount == 0 || sellAmount > withdrawAmount) {
            revert ZeroAmount();
        }

        uint256 proceeds = pair.getAmountOut(sellAmount, address(collateral));
        // The sale has to cover the repayment; a lower caller minimum cannot weaken that.
        if (proceeds < repayAmount || proceeds < minProceeds) revert SlippageExceeded();
        _flashSwap(
            !collateralIsToken0, proceeds, abi.encode(Action.Close, msg.sender, repayAmount, withdrawAmount, sellAmount)
        );
        // What the sale raised beyond the repayment, and the collateral that was not sold, go to the owner.
        collateralOut = withdrawAmount - sellAmount;
        debtAssetOut = proceeds - repayAmount;
        if (collateralOut > 0) collateral.safeTransfer(msg.sender, collateralOut);
        if (debtAssetOut > 0) debtAsset.safeTransfer(msg.sender, debtAssetOut);
        emit Closed(msg.sender, repayAmount, withdrawAmount, sellAmount, collateralOut, debtAssetOut);
        _refund(spent);
    }

    /// @notice Tigris swap callback: the pool has sent its output and checks its invariant once this returns.
    function hook(address sender, uint256 amount0, uint256 amount1, bytes calldata data) external {
        if (!_inSwap || msg.sender != address(pair) || sender != address(this)) revert UnauthorizedCallback();
        // Only the requested side is non-zero.
        uint256 received = amount0 + amount1;
        if (Action(uint8(data[31])) == Action.Open) {
            (, address account, uint256 principal, uint256 borrowAmount) =
                abi.decode(data, (Action, address, uint256, uint256));
            uint256 posted = principal + received;
            collateral.forceApprove(address(vaultManager), posted);
            vaultManager.depositCollateralFor(account, collateralId, posted);
            // The borrow pays the pool directly; VaultManager reverts if it breaks the LTV.
            vaultManager.borrowFor(account, marketId, borrowAmount, address(pair), new bytes[](0));
        } else {
            (, address account, uint256 repayAmount, uint256 withdrawAmount, uint256 sellAmount) =
                abi.decode(data, (Action, address, uint256, uint256, uint256));
            debtAsset.forceApprove(address(vaultManager), repayAmount);
            vaultManager.repay(marketId, repayAmount, account);
            // Reverts if what is left of the position would exceed its borrow limit.
            vaultManager.withdrawCollateralFor(account, collateralId, withdrawAmount, address(this), new bytes[](0));
            collateral.safeTransfer(address(pair), sellAmount);
        }
    }

    /// Takes `amountOut` of token0 (`outIsToken0`) or token1 from the pair; `hook` pays for it.
    function _flashSwap(bool outIsToken0, uint256 amountOut, bytes memory data) internal {
        _inSwap = true;
        pair.swap(outIsToken0 ? amountOut : 0, outIsToken0 ? 0 : amountOut, address(this), data);
        _inSwap = false;
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
