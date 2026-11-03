// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBorrowerOperationsSignatures} from "../interfaces/IBorrowerOperationsSignatures.sol";
import {PToken} from "./PToken.sol";
import {VaultManager} from "./VaultManager.sol";

/// @title TroveRouter
/// @notice Connects a Mezo MUSD trove to Mezodot's pMUSD market in one transaction, in both directions: open a trove
///         with BTC and supply the minted MUSD, then repay or close that trove out of the supply.
///         The caller stays the trove's owner. Mezo's contracts enforce every trove rule (minimum debt, collateral
///         ratios, Recovery Mode); this contract only moves MUSD between them and the pool.
/// @dev The borrower signs each operation for Mezo's BorrowerOperationsSignatures, and every operation here acts only
///      for `msg.sender`. Those signatures do not name a caller, so one can be replayed straight at Mezo's contract
///      with the signed BTC: that spends the replayer's own funds on the borrower's trove and costs the borrower
///      nothing but a failed transaction. MUSD minted here that way goes along with the next open or close.
///      Holds no funds between transactions. There is no owner and no admin function.
contract TroveRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IBorrowerOperationsSignatures public immutable signatures;
    VaultManager public immutable vaultManager;
    PToken public immutable pool;
    IERC20 public immutable musd;
    /// The pool's shares as hub collateral.
    uint256 public immutable collateralId;

    event OpenedAndSupplied(address indexed account, uint256 btc, uint256 debtAmount, uint256 shares, bool posted);
    event RepaidFromSupply(address indexed account, uint256 amount, uint256 shares);
    event ClosedFromSupply(address indexed account, uint256 shares, uint256 fromWallet, uint256 refunded);

    error InvalidConfig();
    error SlippageExceeded();
    error ZeroAmount();

    constructor(
        IBorrowerOperationsSignatures signatures_,
        VaultManager vaultManager_,
        PToken pool_,
        uint256 collateralId_
    ) {
        signatures = signatures_;
        vaultManager = vaultManager_;
        pool = pool_;
        musd = IERC20(pool_.asset());
        collateralId = collateralId_;
        VaultManager.CollateralConfig memory c = vaultManager_.collaterals(collateralId_);
        if (c.isRemote || !c.isShare || c.token != address(pool_)) revert InvalidConfig();
    }

    /// @notice Opens the caller's trove with `msg.value` of BTC and supplies the minted MUSD to the pool.
    /// @param debtAmount MUSD to mint; Mezo adds its borrowing fee and gas compensation to the trove's debt.
    /// @param signature The caller's OpenTrove signature, with this contract as the recipient and `msg.value` as the
    ///        asset amount.
    /// @param minShares Minimum pool shares (slippage guard).
    /// @param post Posts the shares as the caller's hub collateral, which needs `VaultManager.setOperator(this, true)`;
    ///        otherwise they go to the caller's wallet.
    function openAndSupply(
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline,
        uint256 minShares,
        bool post
    ) external payable nonReentrant returns (uint256 shares) {
        signatures.openTroveWithSignature{value: msg.value}(
            debtAmount, upperHint, lowerHint, msg.sender, address(this), signature, deadline
        );
        uint256 amount = musd.balanceOf(address(this));
        musd.forceApprove(address(pool), amount);
        shares = pool.deposit(amount, post ? address(this) : msg.sender);
        if (shares < minShares) revert SlippageExceeded();
        if (post) {
            IERC20(address(pool)).forceApprove(address(vaultManager), shares);
            vaultManager.depositCollateralFor(msg.sender, collateralId, shares);
        }
        emit OpenedAndSupplied(msg.sender, msg.value, debtAmount, shares, post);
    }

    /// @notice Repays part of the caller's trove with MUSD withdrawn from the caller's pool shares.
    /// @dev Needs an allowance of pool shares to this contract, and idle cash in the pool. Mezo keeps the trove at its
    ///      minimum debt or above, so paying it down further takes `closeFromSupply`.
    /// @param amount MUSD to repay, exactly as signed.
    /// @param maxShares Maximum pool shares to spend (slippage guard).
    function repayFromSupply(
        uint256 amount,
        address upperHint,
        address lowerHint,
        bytes calldata signature,
        uint256 deadline,
        uint256 maxShares
    ) external nonReentrant returns (uint256 shares) {
        if (amount == 0) revert ZeroAmount();
        shares = pool.withdraw(amount, address(this), msg.sender);
        if (shares > maxShares) revert SlippageExceeded();
        signatures.repayMUSDWithSignature(amount, upperHint, lowerHint, msg.sender, signature, deadline);
        emit RepaidFromSupply(msg.sender, amount, shares);
    }

    /// @notice Closes the caller's trove with MUSD from the caller's pool shares and wallet. The trove's BTC goes to
    ///         the caller, and MUSD beyond what the trove needed comes back.
    /// @dev The trove owes its debt less the gas compensation, which includes the borrowing fee and interest, so the
    ///      shares from `openAndSupply` alone may fall short. Too little makes the whole call revert. Interest accrues
    ///      until inclusion, so callers should bring a small margin.
    /// @param shares Pool shares to redeem (needs an allowance to this contract).
    /// @param fromWallet MUSD to take from the caller's wallet (needs an allowance to this contract).
    /// @param signature The caller's CloseTrove signature, with the caller as the recipient.
    function closeFromSupply(uint256 shares, uint256 fromWallet, bytes calldata signature, uint256 deadline)
        external
        nonReentrant
        returns (uint256 assets, uint256 refunded)
    {
        if (shares == 0 && fromWallet == 0) revert ZeroAmount();
        if (shares > 0) assets = pool.redeem(shares, address(this), msg.sender);
        if (fromWallet > 0) musd.safeTransferFrom(msg.sender, address(this), fromWallet);
        signatures.closeTroveWithSignature(msg.sender, msg.sender, signature, deadline);
        refunded = musd.balanceOf(address(this));
        if (refunded > 0) musd.safeTransfer(msg.sender, refunded);
        emit ClosedFromSupply(msg.sender, shares, fromWallet, refunded);
    }
}
