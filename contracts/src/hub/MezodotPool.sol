// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC3156FlashLender} from "@openzeppelin/contracts/interfaces/IERC3156FlashLender.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {InterestRateModel} from "./InterestRateModel.sol";

/// @title MezodotPool
/// @notice Lending logic shared by every pToken: Compound-style borrow index, kinked rates,
///         protocol reserves and ERC-3156 flash loans. Debt is owned by VaultManager accounts;
///         only the VaultManager may open or reduce it.
/// @dev Pool value = cash + flashOutstanding + totalBorrows - totalReserves. Counting the
///      outstanding flash amount keeps the share price constant while a flash loan is live,
///      so deposits made inside a flash-loan callback mint fair shares.
abstract contract MezodotPool is Ownable2Step, Pausable, ReentrancyGuard, IERC3156FlashLender {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 public constant FLASH_FEE_BPS = 9;
    /// @notice Highest share of borrower interest the owner can route to reserves (30%).
    uint256 public constant MAX_RESERVE_FACTOR = 0.3e18;
    bytes32 internal constant CALLBACK_SUCCESS = keccak256("ERC3156FlashBorrower.onFlashLoan");

    struct BorrowSnapshot {
        uint256 principal;
        uint256 interestIndex;
    }

    InterestRateModel public immutable interestRateModel;
    /// @notice Share of borrower interest kept as reserves (WAD), owner-set up to MAX_RESERVE_FACTOR.
    uint256 public reserveFactor;

    address public vaultManager;
    uint256 public totalBorrows;
    uint256 public totalReserves;
    uint256 public borrowIndex = WAD;
    uint256 public accrualTimestamp;
    uint256 public flashOutstanding;
    uint256 public supplyCap = type(uint256).max;
    uint256 public borrowCap = type(uint256).max;

    mapping(address account => BorrowSnapshot) internal _borrows;

    event InterestAccrued(uint256 interest, uint256 borrowIndex, uint256 totalBorrows, uint256 totalReserves);
    event Borrow(address indexed account, uint256 amount, address indexed receiver, uint256 accountDebt);
    event RepayBorrow(address indexed account, uint256 amount, uint256 accountDebt);
    event FlashLoan(address indexed receiver, uint256 amount, uint256 fee);
    event CapsSet(uint256 supplyCap, uint256 borrowCap);
    event ReservesWithdrawn(address indexed to, uint256 amount);
    event BadDebtWrittenOff(address indexed account, uint256 amount, uint256 fromReserves);
    event VaultManagerSet(address vaultManager);
    event ReserveFactorSet(uint256 reserveFactor);

    error NotVaultManager();
    error VaultManagerAlreadySet();
    error InsufficientCash();
    error BorrowCapExceeded();
    error ZeroAmount();
    error UnsupportedToken();
    error FlashLoanActive();
    error FlashLoanCallbackFailed();
    error InvalidParams();

    modifier onlyVaultManager() {
        if (msg.sender != vaultManager) revert NotVaultManager();
        _;
    }

    constructor(InterestRateModel irm, uint256 reserveFactor_, address owner_) Ownable(owner_) {
        if (address(irm) == address(0) || reserveFactor_ > MAX_RESERVE_FACTOR) revert InvalidParams();
        interestRateModel = irm;
        reserveFactor = reserveFactor_;
        accrualTimestamp = block.timestamp;
    }

    function _underlying() internal view virtual returns (IERC20);

    // --- Admin ---------------------------------------------------------------

    function setVaultManager(address vm) external onlyOwner {
        if (vaultManager != address(0)) revert VaultManagerAlreadySet();
        if (vm == address(0)) revert InvalidParams();
        vaultManager = vm;
        emit VaultManagerSet(vm);
    }

    function setCaps(uint256 supplyCap_, uint256 borrowCap_) external onlyOwner {
        supplyCap = supplyCap_;
        borrowCap = borrowCap_;
        emit CapsSet(supplyCap_, borrowCap_);
    }

    /// @notice Sets the reserve share of future interest; interest accrued so far keeps the old split.
    function setReserveFactor(uint256 reserveFactor_) external onlyOwner {
        if (reserveFactor_ > MAX_RESERVE_FACTOR) revert InvalidParams();
        accrueInterest();
        reserveFactor = reserveFactor_;
        emit ReserveFactorSet(reserveFactor_);
    }

    function withdrawReserves(uint256 amount, address to) external onlyOwner nonReentrant {
        accrueInterest();
        if (amount > totalReserves || amount > cash()) revert InsufficientCash();
        totalReserves -= amount;
        _underlying().safeTransfer(to, amount);
        emit ReservesWithdrawn(to, amount);
    }

    /// @notice Blocks new deposits, borrows and flash loans. Withdrawals and repayments stay open.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --- Interest ------------------------------------------------------------

    function cash() public view returns (uint256) {
        return _underlying().balanceOf(address(this));
    }

    /// @dev Borrows, reserves and index as they would be after accruing up to now.
    function _accrued() internal view returns (uint256 borrows, uint256 reserves, uint256 index) {
        borrows = totalBorrows;
        reserves = totalReserves;
        index = borrowIndex;
        uint256 elapsed = block.timestamp - accrualTimestamp;
        if (elapsed == 0 || borrows == 0) return (borrows, reserves, index);
        uint256 factor = interestRateModel.borrowRatePerSecond(cash() + flashOutstanding, borrows, reserves) * elapsed;
        uint256 interest = borrows * factor / WAD;
        borrows += interest;
        reserves += interest * reserveFactor / WAD;
        index += index * factor / WAD;
    }

    function accrueInterest() public {
        if (block.timestamp == accrualTimestamp) return;
        (uint256 borrows, uint256 reserves, uint256 index) = _accrued();
        uint256 interest = borrows - totalBorrows;
        totalBorrows = borrows;
        totalReserves = reserves;
        borrowIndex = index;
        accrualTimestamp = block.timestamp;
        if (interest > 0) emit InterestAccrued(interest, index, borrows, reserves);
    }

    function _poolAssets() internal view returns (uint256) {
        (uint256 borrows, uint256 reserves,) = _accrued();
        uint256 gross = cash() + flashOutstanding + borrows;
        return gross > reserves ? gross - reserves : 0;
    }

    function borrowRatePerSecond() external view returns (uint256) {
        return interestRateModel.borrowRatePerSecond(cash() + flashOutstanding, totalBorrows, totalReserves);
    }

    function supplyRatePerSecond() external view returns (uint256) {
        return
            interestRateModel.supplyRatePerSecond(cash() + flashOutstanding, totalBorrows, totalReserves, reserveFactor);
    }

    // --- Debt ----------------------------------------------------------------

    function _debtAt(address account, uint256 index) internal view returns (uint256) {
        BorrowSnapshot memory snap = _borrows[account];
        if (snap.principal == 0) return 0;
        // Round up so rounding never favours the borrower.
        return Math.mulDiv(snap.principal, index, snap.interestIndex, Math.Rounding.Ceil);
    }

    /// @notice Debt as of the last accrual.
    function borrowBalanceStored(address account) public view returns (uint256) {
        return _debtAt(account, borrowIndex);
    }

    /// @notice Debt including interest pending since the last accrual (read-only).
    function borrowBalanceView(address account) external view returns (uint256) {
        (,, uint256 index) = _accrued();
        return _debtAt(account, index);
    }

    function borrowBalanceCurrent(address account) external returns (uint256) {
        accrueInterest();
        return borrowBalanceStored(account);
    }

    function borrow(address account, uint256 amount, address receiver)
        external
        onlyVaultManager
        nonReentrant
        whenNotPaused
    {
        accrueInterest();
        if (amount == 0) revert ZeroAmount();
        if (amount > cash()) revert InsufficientCash();
        if (totalBorrows + amount > borrowCap) revert BorrowCapExceeded();
        uint256 debt = borrowBalanceStored(account) + amount;
        _borrows[account] = BorrowSnapshot(debt, borrowIndex);
        totalBorrows += amount;
        _underlying().safeTransfer(receiver, amount);
        emit Borrow(account, amount, receiver, debt);
    }

    /// @notice Records a repayment whose tokens the VaultManager has already transferred in.
    /// @return applied The amount applied, capped at the outstanding debt.
    function notifyRepay(address account, uint256 amount)
        external
        onlyVaultManager
        nonReentrant
        returns (uint256 applied)
    {
        accrueInterest();
        uint256 owed = borrowBalanceStored(account);
        applied = amount > owed ? owed : amount;
        _reduceDebt(account, owed, applied);
    }

    /// @dev `owed` is the account's current debt (after accrual); `amount` <= `owed`.
    function _reduceDebt(address account, uint256 owed, uint256 amount) internal {
        uint256 remaining = owed - amount;
        _borrows[account] = BorrowSnapshot(remaining, borrowIndex);
        // Per-account round-up can make the sum of debts exceed totalBorrows by dust.
        totalBorrows = totalBorrows > amount ? totalBorrows - amount : 0;
        emit RepayBorrow(account, amount, remaining);
    }

    /// @notice Writes off `account`'s remaining debt once it has no collateral left (VaultManager, after the
    ///         final liquidation). Reserves absorb the loss first; the rest lowers the share price, so suppliers
    ///         share it pro rata instead of phantom borrows accruing interest nobody pays and inflating rates.
    /// @return amount Debt written off.
    function writeOff(address account) external onlyVaultManager nonReentrant returns (uint256 amount) {
        accrueInterest();
        amount = borrowBalanceStored(account);
        if (amount == 0) return 0;
        _borrows[account] = BorrowSnapshot(0, borrowIndex);
        // Per-account round-up can exceed totalBorrows by dust (see notifyRepay).
        totalBorrows = totalBorrows > amount ? totalBorrows - amount : 0;
        uint256 fromReserves = Math.min(amount, totalReserves);
        totalReserves -= fromReserves;
        emit BadDebtWrittenOff(account, amount, fromReserves);
    }

    // --- ERC-3156 flash loans --------------------------------------------------

    function maxFlashLoan(address token) external view returns (uint256) {
        return token == address(_underlying()) ? cash() : 0;
    }

    function flashFee(address token, uint256 amount) public view returns (uint256) {
        if (token != address(_underlying())) revert UnsupportedToken();
        return Math.mulDiv(amount, FLASH_FEE_BPS, 10_000, Math.Rounding.Ceil);
    }

    /// @dev Deliberately not `nonReentrant`: the borrower must be able to deposit into this pool
    ///      and borrow from it (via VaultManager) inside the callback. Nested flash loans are blocked.
    function flashLoan(IERC3156FlashBorrower receiver, address token, uint256 amount, bytes calldata data)
        external
        whenNotPaused
        returns (bool)
    {
        if (token != address(_underlying())) revert UnsupportedToken();
        if (flashOutstanding != 0) revert FlashLoanActive();
        if (amount == 0) revert ZeroAmount();
        if (amount > cash()) revert InsufficientCash();
        accrueInterest();
        uint256 fee = flashFee(token, amount);

        flashOutstanding = amount;
        IERC20(token).safeTransfer(address(receiver), amount);
        if (receiver.onFlashLoan(msg.sender, token, amount, fee, data) != CALLBACK_SUCCESS) {
            revert FlashLoanCallbackFailed();
        }
        IERC20(token).safeTransferFrom(address(receiver), address(this), amount + fee);
        flashOutstanding = 0;
        totalReserves += fee;
        emit FlashLoan(address(receiver), amount, fee);
        return true;
    }
}
