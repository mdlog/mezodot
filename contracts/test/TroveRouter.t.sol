// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {HubFixture} from "./utils/HubFixture.sol";
import {TroveRouter} from "../src/hub/TroveRouter.sol";
import {PToken} from "../src/hub/PToken.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {IBorrowerOperationsSignatures} from "../src/interfaces/IBorrowerOperationsSignatures.sol";
import {MockBorrowerOperationsSignatures} from "./mocks/MockBorrowerOperationsSignatures.sol";

contract TroveRouterTest is HubFixture {
    uint256 internal constant DEBT = 2_000e18;
    uint256 internal constant BTC = 0.05e18;
    bytes internal constant SIG = hex"51";

    MockBorrowerOperationsSignatures internal mezo_;
    TroveRouter internal router;
    uint256 internal deadline;

    function setUp() public {
        setUpHub();
        mezo_ = new MockBorrowerOperationsSignatures(musd);
        router = new TroveRouter(IBorrowerOperationsSignatures(address(mezo_)), vaultManager, pMUSD, pMusdCollateral);
        deadline = block.timestamp + 600;
        vm.deal(alice, 1e18);
    }

    function _open(bool post) internal returns (uint256 shares) {
        vm.prank(alice);
        shares = router.openAndSupply{value: BTC}(DEBT, address(1), address(2), SIG, deadline, 0, post);
    }

    function _approveShares() internal {
        vm.prank(alice);
        IERC20(address(pMUSD)).approve(address(router), type(uint256).max);
    }

    function _assertRouterEmpty() internal view {
        assertEq(musd.balanceOf(address(router)), 0, "router keeps MUSD");
        assertEq(pMUSD.balanceOf(address(router)), 0, "router keeps pMUSD");
        assertEq(address(router).balance, 0, "router keeps BTC");
    }

    // ------------------------------------------------------------------ constructor

    function test_constructor_refusesACollateralOtherThanThePoolsShares() public {
        vm.expectRevert(TroveRouter.InvalidConfig.selector);
        new TroveRouter(IBorrowerOperationsSignatures(address(mezo_)), vaultManager, pMUSD, pMezoCollateral);
    }

    // ------------------------------------------------------------------ open

    function test_open_turnsTheMintedMusdIntoTheCallersShares() public {
        uint256 expected = pMUSD.previewDeposit(DEBT);
        uint256 shares = _open(false);
        assertEq(shares, expected);
        assertEq(pMUSD.balanceOf(alice), expected);
        assertEq(mezo_.debt(alice), DEBT + 200e18, "the trove belongs to the caller");
        assertEq(mezo_.coll(alice), BTC, "the BTC backs the trove");
        _assertRouterEmpty();
    }

    function test_open_canPostTheSharesAsCollateral() public {
        vm.prank(alice);
        vaultManager.setOperator(address(router), true);
        uint256 shares = _open(true);
        assertEq(pMUSD.balanceOf(alice), 0);
        assertEq(vaultManager.collateralBalance(alice, pMusdCollateral), shares);
        _assertRouterEmpty();
    }

    function test_open_postingNeedsTheOperatorApproval() public {
        vm.prank(alice);
        vm.expectRevert(VaultManager.NotOperator.selector);
        router.openAndSupply{value: BTC}(DEBT, address(1), address(2), SIG, deadline, 0, true);
    }

    function test_open_revertsBelowTheMinimumShares() public {
        uint256 tooMany = pMUSD.previewDeposit(DEBT) + 1;
        vm.prank(alice);
        vm.expectRevert(TroveRouter.SlippageExceeded.selector);
        router.openAndSupply{value: BTC}(DEBT, address(1), address(2), SIG, deadline, tooMany, false);
    }

    function test_open_aRefusedSignatureLeavesNothingBehind() public {
        vm.prank(alice);
        vm.expectRevert("invalid signature");
        router.openAndSupply{value: BTC}(DEBT, address(1), address(2), "", deadline, 0, false);
        assertEq(alice.balance, 1e18);
        _assertRouterEmpty();
    }

    function test_open_strayMusdLeavesWithTheNextCaller() public {
        // A signature replayed straight at Mezo's contract mints to this router; it cannot stay here for good.
        musd.mint(address(router), 7e18);
        uint256 shares = _open(false);
        assertEq(shares, pMUSD.previewDeposit(DEBT + 7e18));
        _assertRouterEmpty();
    }

    // ------------------------------------------------------------------ repay

    function test_repay_paysTheTroveFromTheCallersShares() public {
        uint256 shares = _open(false);
        _approveShares();
        uint256 expected = pMUSD.previewWithdraw(100e18);
        vm.prank(alice);
        uint256 burned = router.repayFromSupply(100e18, address(1), address(2), SIG, deadline, expected);
        assertEq(burned, expected);
        assertEq(pMUSD.balanceOf(alice), shares - expected);
        assertEq(mezo_.debt(alice), DEBT + 100e18);
        _assertRouterEmpty();
    }

    function test_repay_revertsAboveTheMaximumShares() public {
        _open(false);
        _approveShares();
        uint256 tooFew = pMUSD.previewWithdraw(100e18) - 1;
        vm.prank(alice);
        vm.expectRevert(TroveRouter.SlippageExceeded.selector);
        router.repayFromSupply(100e18, address(1), address(2), SIG, deadline, tooFew);
    }

    function test_repay_needsTheShareAllowance() public {
        _open(false);
        uint256 maxShares = pMUSD.previewWithdraw(100e18);
        vm.prank(alice);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientAllowance.selector);
        router.repayFromSupply(100e18, address(1), address(2), SIG, deadline, maxShares);
    }

    function test_repay_refusesZero() public {
        vm.prank(alice);
        vm.expectRevert(TroveRouter.ZeroAmount.selector);
        router.repayFromSupply(0, address(1), address(2), SIG, deadline, 0);
    }

    function test_repay_anotherAccountsSharesCannotBeSpent() public {
        _open(false);
        _approveShares();
        vm.prank(makeAddr("mallory"));
        vm.expectRevert(); // mallory holds no shares and has no allowance from alice: the router only spends the caller's
        router.repayFromSupply(100e18, address(1), address(2), SIG, deadline, type(uint256).max);
    }

    // ------------------------------------------------------------------ close

    function test_close_paysTheBtcToTheCallerAndReturnsTheRestOfTheMusd() public {
        _open(false);
        supplyFor(alice, pMUSD, 10e18); // earlier supply: more than the trove owes less its gas compensation
        _approveShares();
        uint256 balance = alice.balance;
        uint256 shares = pMUSD.balanceOf(alice);
        vm.prank(alice);
        (uint256 assets, uint256 refunded) = router.closeFromSupply(shares, 0, SIG, deadline);
        assertEq(assets, DEBT + 10e18);
        assertEq(refunded, 10e18);
        assertEq(musd.balanceOf(alice), 10e18);
        assertEq(alice.balance, balance + BTC);
        assertEq(mezo_.debt(alice), 0);
        assertEq(pMUSD.balanceOf(alice), 0);
        _assertRouterEmpty();
    }

    function test_close_topsUpFromTheWalletWhenTheSupplyFallsShort() public {
        // The trove also owes its borrowing fee and interest, so the pMUSD it minted never covers it alone.
        uint256 shares = _open(false);
        vm.store(address(mezo_), keccak256(abi.encode(alice, uint256(0))), bytes32(uint256(DEBT + 203e18)));
        _approveShares();
        musd.mint(alice, 5e18);
        vm.startPrank(alice);
        musd.approve(address(router), 5e18);
        (, uint256 refunded) = router.closeFromSupply(shares, 5e18, SIG, deadline);
        vm.stopPrank();
        assertEq(refunded, 2e18);
        assertEq(musd.balanceOf(alice), 2e18);
        assertEq(mezo_.debt(alice), 0);
        _assertRouterEmpty();
    }

    function test_close_revertsWhenTheFundsDoNotCoverTheDebt() public {
        uint256 shares = _open(false);
        _approveShares();
        uint256 balance = pMUSD.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert();
        router.closeFromSupply(shares / 2, 0, SIG, deadline);
        assertGt(mezo_.debt(alice), 0, "the trove stays open");
        assertEq(pMUSD.balanceOf(alice), balance, "the shares stay with the caller");
    }

    function test_close_refusesNothing() public {
        vm.prank(alice);
        vm.expectRevert(TroveRouter.ZeroAmount.selector);
        router.closeFromSupply(0, 0, SIG, deadline);
    }

    function test_close_paysAContractBorrowerThroughItsReceiveFunction() public {
        ContractWallet wallet = new ContractWallet(router, pMUSD);
        vm.deal(address(wallet), 1e18);
        uint256 shares = wallet.open(DEBT, BTC, SIG, deadline);
        wallet.close(shares, SIG, deadline);
        assertEq(address(wallet).balance, 1e18);
        assertEq(mezo_.debt(address(wallet)), 0);
    }
}

/// @notice A contract as the borrower: BTC arrives through its receive function while the close is in flight.
contract ContractWallet {
    TroveRouter internal immutable router;
    PToken internal immutable pool;

    constructor(TroveRouter router_, PToken pool_) {
        router = router_;
        pool = pool_;
    }

    receive() external payable {}

    function open(uint256 debt, uint256 btc, bytes calldata sig, uint256 deadline) external returns (uint256 shares) {
        shares = router.openAndSupply{value: btc}(debt, address(1), address(2), sig, deadline, 0, false);
        IERC20(address(pool)).approve(address(router), type(uint256).max);
    }

    function close(uint256 shares, bytes calldata sig, uint256 deadline) external {
        router.closeFromSupply(shares, 0, sig, deadline);
    }
}
