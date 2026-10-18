// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {PToken} from "./PToken.sol";
import {VaultManager} from "./VaultManager.sol";
import {ITigrisRouter} from "../interfaces/ITigrisRouter.sol";

/// @title SwapLeverageManager
/// @notice One-transaction leverage on a plain hub collateral (Mezo's BTC) against debt in the MUSD market,
///         using the MUSD pool's flash loan and the Tigris DEX:
///         open:  flash-borrow MUSD → swap it to the collateral → post principal + bought collateral →
///                borrow MUSD against it → repay the flash loan.
///         close: flash-borrow MUSD → repay the debt → withdraw collateral → sell part of it to MUSD →
///                repay the flash loan → return the remaining collateral and MUSD to the owner.
///         VaultManager enforces LTV and health on every step, so an over-levered position simply reverts.
/// @dev Users approve the collateral to this contract and call `VaultManager.setOperator(this, true)`.
///      Swap minimums are computed off-chain from router quotes; holds no funds between transactions.
contract SwapLeverageManager is IERC3156FlashBorrower, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 internal constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    enum Action {
        Open,
        Close
    }

    VaultManager public immutable vaultManager;
    /// MUSD pool: flash lender and the debt market.
    PToken public immutable pool;
    IERC20 public immutable debtAsset;
    IERC20 public immutable collateral;
    uint256 public immutable marketId;
    uint256 public immutable collateralId;
    ITigrisRouter public immutable router;
    address public immutable factory;
    bool public immutable stable;

    /// Set only for the duration of our own flash loan, so callbacks cannot be triggered externally.
    bool private _inFlash;
    uint256 private _lastBought;
    uint256 private _lastProceeds;

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

    constructor(
        VaultManager vaultManager_,
        PToken pool_,
        uint256 marketId_,
        uint256 collateralId_,
        ITigrisRouter router_,
        address factory_,
        bool stable_
    ) {
        vaultManager = vaultManager_;
        pool = pool_;
        debtAsset = IERC20(pool_.asset());
        marketId = marketId_;
        collateralId = collateralId_;
        collateral = IERC20(vaultManager_.collaterals(collateralId_).token);
        router = router_;
        factory = factory_;
        stable = stable_;
    }

    /// @param principal Collateral the caller adds from their wallet.
    /// @param borrowAmount MUSD flash-borrowed and swapped into collateral; it becomes debt plus the 0.09% flash fee.
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

        uint256 fee = pool.flashFee(address(debtAsset), borrowAmount);
        _flash(borrowAmount, abi.encode(Action.Open, msg.sender, principal, minBought, deadline));
        posted = principal + _lastBought;
        debt = borrowAmount + fee;
        emit Opened(msg.sender, principal, borrowAmount, _lastBought, debt);
        _refund(spent);
    }

    /// @param repayAmount MUSD debt to repay; `type(uint256).max` repays all of it.
    /// @param withdrawAmount Collateral to withdraw; `type(uint256).max` withdraws all of it.
    /// @param sellAmount Part of the withdrawn collateral sold for MUSD to repay the flash loan.
    /// @param minProceeds Minimum MUSD the sale must return; it must at least cover the flash loan plus fee.
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
        if (repayAmount == type(uint256).max) repayAmount = pool.borrowBalanceCurrent(msg.sender);
        if (withdrawAmount == type(uint256).max) {
            withdrawAmount = vaultManager.collateralBalance(msg.sender, collateralId);
        }
        if (repayAmount == 0 || withdrawAmount == 0 || sellAmount == 0 || sellAmount > withdrawAmount) {
            revert ZeroAmount();
        }

        uint256 fee = pool.flashFee(address(debtAsset), repayAmount);
        _flash(repayAmount, abi.encode(Action.Close, msg.sender, withdrawAmount, sellAmount, minProceeds, deadline));
        // What the sale raised beyond the flash repayment, and the collateral that was not sold, go to the owner.
        collateralOut = withdrawAmount - sellAmount;
        debtAssetOut = _lastProceeds - repayAmount - fee;
        if (collateralOut > 0) collateral.safeTransfer(msg.sender, collateralOut);
        if (debtAssetOut > 0) debtAsset.safeTransfer(msg.sender, debtAssetOut);
        emit Closed(msg.sender, repayAmount, withdrawAmount, sellAmount, collateralOut, debtAssetOut);
        _refund(spent);
    }

    function onFlashLoan(address initiator, address token, uint256 amount, uint256 fee, bytes calldata data)
        external
        returns (bytes32)
    {
        if (!_inFlash || msg.sender != address(pool) || initiator != address(this) || token != address(debtAsset)) {
            revert UnauthorizedCallback();
        }
        if (Action(uint8(data[31])) == Action.Open) {
            (, address account, uint256 principal, uint256 minBought, uint256 deadline) =
                abi.decode(data, (Action, address, uint256, uint256, uint256));
            _onOpen(account, amount, fee, principal, minBought, deadline);
        } else {
            (, address account, uint256 withdrawAmount, uint256 sellAmount, uint256 minProceeds, uint256 deadline) =
                abi.decode(data, (Action, address, uint256, uint256, uint256, uint256));
            _onClose(account, amount, fee, withdrawAmount, sellAmount, minProceeds, deadline);
        }
        debtAsset.forceApprove(address(pool), amount + fee);
        return CALLBACK_SUCCESS;
    }

    function _onOpen(
        address account,
        uint256 amount,
        uint256 fee,
        uint256 principal,
        uint256 minBought,
        uint256 deadline
    ) internal {
        uint256 bought = _swap(debtAsset, collateral, amount, minBought, deadline);
        uint256 posted = principal + bought;
        collateral.forceApprove(address(vaultManager), posted);
        vaultManager.depositCollateralFor(account, collateralId, posted);
        // Borrow exactly what the flash loan needs back; VaultManager reverts if this breaks the LTV.
        vaultManager.borrowFor(account, marketId, amount + fee, address(this), new bytes[](0));
        _lastBought = bought;
    }

    function _onClose(
        address account,
        uint256 amount,
        uint256 fee,
        uint256 withdrawAmount,
        uint256 sellAmount,
        uint256 minProceeds,
        uint256 deadline
    ) internal {
        debtAsset.forceApprove(address(vaultManager), amount);
        vaultManager.repay(marketId, amount, account);
        // Reverts if what is left of the position would exceed its borrow limit.
        vaultManager.withdrawCollateralFor(account, collateralId, withdrawAmount, address(this), new bytes[](0));
        // The sale has to cover the flash loan; a lower caller minimum cannot weaken that.
        uint256 floor = amount + fee > minProceeds ? amount + fee : minProceeds;
        _lastProceeds = _swap(collateral, debtAsset, sellAmount, floor, deadline);
    }

    function _swap(IERC20 from, IERC20 to, uint256 amountIn, uint256 minOut, uint256 deadline)
        internal
        returns (uint256 out)
    {
        ITigrisRouter.Route[] memory routes = new ITigrisRouter.Route[](1);
        routes[0] = ITigrisRouter.Route({from: address(from), to: address(to), stable: stable, factory: factory});
        from.forceApprove(address(router), amountIn);
        uint256 before = to.balanceOf(address(this));
        router.swapExactTokensForTokens(amountIn, minOut, routes, address(this), deadline);
        // Measured, not trusted from the router's return value.
        out = to.balanceOf(address(this)) - before;
        if (out < minOut) revert SlippageExceeded();
    }

    function _flash(uint256 amount, bytes memory data) internal {
        _inFlash = true;
        pool.flashLoan(this, address(debtAsset), amount, data);
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
