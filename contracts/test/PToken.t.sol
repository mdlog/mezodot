// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC3156FlashBorrower} from "@openzeppelin/contracts/interfaces/IERC3156FlashBorrower.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {InterestRateModel} from "../src/hub/InterestRateModel.sol";
import {MezodotPool} from "../src/hub/MezodotPool.sol";
import {PToken} from "../src/hub/PToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// Flash borrower that optionally deposits the borrowed funds back into the pool mid-loan.
contract FlashDepositor is IERC3156FlashBorrower {
    PToken public pool;
    bool public depositDuringLoan;
    bool public repay = true;
    uint256 public sharesMinted;

    constructor(PToken pool_) {
        pool = pool_;
    }

    function configure(bool deposit_, bool repay_) external {
        depositDuringLoan = deposit_;
        repay = repay_;
    }

    function onFlashLoan(address, address token, uint256 amount, uint256 fee, bytes calldata)
        external
        returns (bytes32)
    {
        if (depositDuringLoan) {
            // Deposit the borrower's own capital while the pool's cash is lent out, and keep the shares.
            uint256 own = IERC20(token).balanceOf(address(this)) - amount - fee;
            IERC20(token).approve(address(pool), own);
            sharesMinted = pool.deposit(own, address(this));
        }
        if (repay) IERC20(token).approve(address(pool), amount + fee);
        return keccak256("ERC3156FlashBorrower.onFlashLoan");
    }
}

contract PTokenTest is Test {
    uint256 internal constant WAD = 1e18;
    MockERC20 internal musd;
    PToken internal pool;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal borrower = makeAddr("borrower");

    function setUp() public {
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        InterestRateModel irm = new InterestRateModel(0, 0.06e18, 0.8e18, 0.8e18);
        pool = new PToken(IERC20(address(musd)), "Mezodot MUSD", "pMUSD", irm, 0.1e18, address(this));
        // This test contract acts as the VaultManager.
        pool.setVaultManager(address(this));
        _deposit(alice, 1_000_000e18);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        musd.mint(who, amount);
        vm.startPrank(who);
        musd.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    function _repay(address account, uint256 amount) internal {
        musd.mint(address(this), amount);
        pool.accrueInterest();
        musd.transfer(address(pool), amount);
        pool.notifyRepay(account, amount);
    }

    // --- ERC-4626 basics -------------------------------------------------

    function test_prdFlowA_depositMintsShares() public {
        uint256 shares = _deposit(bob, 10_000e18);
        assertGt(shares, 0);
        assertApproxEqAbs(pool.convertToAssets(shares), 10_000e18, 1);
        assertEq(pool.decimals(), 24); // 18 + virtual offset 6
    }

    function test_exchangeRateGrowsWithBorrowerInterest() public {
        uint256 shares = _deposit(bob, 10_000e18);
        pool.borrow(borrower, 600_000e18, borrower); // ~60% utilization
        uint256 utilBefore = 600_000e18 * WAD / pool.totalAssets();
        uint256 supplyPerSec = pool.supplyRatePerSecond();
        skip(365 days);
        uint256 value = pool.convertToAssets(shares);
        assertGt(value, 10_000e18);
        // Simple-interest accrual over one period: growth ≈ supply rate × 1 year.
        uint256 expected = 10_000e18 + 10_000e18 * supplyPerSec * 365 days / WAD;
        assertApproxEqRel(value, expected, 0.001e18);
        assertGt(utilBefore, 0.5e18);
    }

    function test_reservesAccrueReserveFactorShare() public {
        pool.borrow(borrower, 500_000e18, borrower);
        uint256 borrowsBefore = pool.totalBorrows();
        skip(30 days);
        pool.accrueInterest();
        uint256 interest = pool.totalBorrows() - borrowsBefore;
        assertApproxEqAbs(pool.totalReserves(), interest / 10, 1);
    }

    function test_reserveFactorIsOwnerSettableUpToCap() public {
        pool.borrow(borrower, 500_000e18, borrower);
        skip(30 days);
        // Changing the factor accrues first, so interest earned so far keeps the old 10% split.
        pool.setReserveFactor(0.2e18);
        uint256 reservesAtSwitch = pool.totalReserves();
        assertGt(reservesAtSwitch, 0);
        assertEq(pool.reserveFactor(), 0.2e18);

        uint256 borrowsBefore = pool.totalBorrows();
        skip(30 days);
        pool.accrueInterest();
        uint256 interest = pool.totalBorrows() - borrowsBefore;
        assertApproxEqAbs(pool.totalReserves() - reservesAtSwitch, interest / 5, 1);

        uint256 cap = pool.MAX_RESERVE_FACTOR();
        vm.expectRevert(MezodotPool.InvalidParams.selector);
        pool.setReserveFactor(cap + 1);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, borrower));
        pool.setReserveFactor(0.1e18);
    }

    function test_constructorRejectsReserveFactorAboveCap() public {
        InterestRateModel irm = new InterestRateModel(0, 0.06e18, 0.8e18, 0.8e18);
        vm.expectRevert(MezodotPool.InvalidParams.selector);
        new PToken(IERC20(address(musd)), "x", "x", irm, 0.3e18 + 1, address(this));
    }

    function test_debtRoundsUpAndAccrues() public {
        pool.borrow(borrower, 1_000e18, borrower);
        assertEq(pool.borrowBalanceStored(borrower), 1_000e18);
        skip(1 days);
        uint256 owed = pool.borrowBalanceCurrent(borrower);
        assertGt(owed, 1_000e18);
        // Sum of debts may exceed totalBorrows by rounding dust, never the other way round by more than dust.
        assertApproxEqAbs(owed, pool.totalBorrows(), 2);
    }

    function test_repayReducesDebtAndCapsAtOwed() public {
        pool.borrow(borrower, 1_000e18, borrower);
        _repay(borrower, 400e18);
        assertApproxEqAbs(pool.borrowBalanceStored(borrower), 600e18, 1);
        pool.accrueInterest();
        uint256 owed = pool.borrowBalanceStored(borrower);
        musd.mint(address(this), owed);
        musd.transfer(address(pool), owed);
        assertEq(pool.notifyRepay(borrower, type(uint256).max), owed);
        assertEq(pool.borrowBalanceStored(borrower), 0);
    }

    function test_onlyVaultManagerCanBorrowOrRepay() public {
        vm.prank(alice);
        vm.expectRevert(MezodotPool.NotVaultManager.selector);
        pool.borrow(alice, 1, alice);
        vm.prank(alice);
        vm.expectRevert(MezodotPool.NotVaultManager.selector);
        pool.notifyRepay(alice, 1);
    }

    function test_vaultManagerSetOnce() public {
        vm.expectRevert(MezodotPool.VaultManagerAlreadySet.selector);
        pool.setVaultManager(alice);
    }

    function test_withdrawCappedByCash() public {
        pool.borrow(borrower, 900_000e18, borrower);
        assertApproxEqAbs(pool.maxWithdraw(alice), 100_000e18, 1);
        vm.prank(alice);
        vm.expectRevert();
        pool.withdraw(200_000e18, alice, alice);
    }

    function test_borrowCannotExceedCash() public {
        vm.expectRevert(MezodotPool.InsufficientCash.selector);
        pool.borrow(borrower, 1_000_001e18, borrower);
    }

    function test_caps() public {
        pool.setCaps(1_005_000e18, 100e18);
        assertApproxEqAbs(pool.maxDeposit(bob), 5_000e18, 1);
        musd.mint(bob, 10_000e18);
        vm.startPrank(bob);
        musd.approve(address(pool), 10_000e18);
        vm.expectRevert();
        pool.deposit(10_000e18, bob);
        vm.stopPrank();
        vm.expectRevert(MezodotPool.BorrowCapExceeded.selector);
        pool.borrow(borrower, 101e18, borrower);
    }

    function test_pauseBlocksDepositAndBorrowButNotWithdrawOrRepay() public {
        pool.borrow(borrower, 100e18, borrower);
        pool.pause();
        assertEq(pool.maxDeposit(bob), 0);
        vm.expectRevert();
        pool.borrow(borrower, 1e18, borrower);
        vm.prank(alice);
        pool.withdraw(1e18, alice, alice);
        _repay(borrower, 50e18);
    }

    function test_inflationAttackUnprofitable() public {
        PToken fresh = new PToken(
            IERC20(address(musd)), "x", "x", new InterestRateModel(0, 0.06e18, 0.8e18, 0.8e18), 0.1e18, address(this)
        );
        address attacker = makeAddr("attacker");
        musd.mint(attacker, 10_001e18);
        vm.startPrank(attacker);
        musd.approve(address(fresh), 1);
        fresh.deposit(1, attacker);
        musd.transfer(address(fresh), 10_000e18); // donation to inflate share price
        vm.stopPrank();

        musd.mint(bob, 10_000e18);
        vm.startPrank(bob);
        musd.approve(address(fresh), 10_000e18);
        uint256 shares = fresh.deposit(10_000e18, bob);
        vm.stopPrank();
        // Victim keeps (almost) everything; attacker cannot recover the donation.
        assertGe(fresh.convertToAssets(shares), 9_999e18);
        assertLt(fresh.convertToAssets(fresh.balanceOf(attacker)), 10_000e18);
    }

    // --- Flash loans --------------------------------------------------------

    function test_flashLoanFeeGoesToReserves() public {
        FlashDepositor fb = new FlashDepositor(pool);
        musd.mint(address(fb), 90e18); // fee
        uint256 assetsBefore = pool.totalAssets();
        pool.flashLoan(fb, address(musd), 100_000e18, "");
        assertEq(pool.totalReserves(), 90e18); // 9 bps
        assertEq(pool.flashFee(address(musd), 100_000e18), 90e18);
        // Fees belong to the protocol, not suppliers.
        assertEq(pool.totalAssets(), assetsBefore);
    }

    function test_flashLoanUnpaidReverts() public {
        FlashDepositor fb = new FlashDepositor(pool);
        fb.configure(false, false);
        vm.expectRevert();
        pool.flashLoan(fb, address(musd), 1_000e18, "");
    }

    function test_flashLoanWrongTokenReverts() public {
        FlashDepositor fb = new FlashDepositor(pool);
        vm.expectRevert(MezodotPool.UnsupportedToken.selector);
        pool.flashLoan(fb, address(0xdead), 1, "");
    }

    /// Review Focus 1: depositing while the pool's own flash loan is outstanding must not
    /// mint extra shares (totalAssets has to include the lent-out amount).
    function test_depositDuringFlashLoanMintsFairShares() public {
        FlashDepositor fb = new FlashDepositor(pool);
        fb.configure(true, true);
        uint256 amount = 900_000e18;
        uint256 own = 10_000e18;
        uint256 fairShares = pool.previewDeposit(own);
        musd.mint(address(fb), own + pool.flashFee(address(musd), amount));
        pool.flashLoan(fb, address(musd), amount, "");
        assertApproxEqRel(fb.sharesMinted(), fairShares, 1e12);
        assertApproxEqAbs(pool.convertToAssets(fb.sharesMinted()), own, 1e6);
    }
}
