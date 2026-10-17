// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HubFixture} from "../utils/HubFixture.sol";
import {PToken} from "../../src/hub/PToken.sol";
import {VaultManager} from "../../src/hub/VaultManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// Random supply / collateral / borrow / repay / time-travel sequences against the MUSD pool.
contract PoolHandler is Test {
    PToken public pool;
    VaultManager public vm_;
    MockERC20 public musd;
    uint256 public marketId;
    uint256 public collateralId;
    address[] public actors;
    HubFixtureView public immutable fixture;
    uint256 public warps;

    constructor(PToken pool_, VaultManager vaultManager, uint256 marketId_, uint256 collateralId_) {
        fixture = HubFixtureView(msg.sender);
        pool = pool_;
        vm_ = vaultManager;
        musd = MockERC20(pool_.asset());
        marketId = marketId_;
        collateralId = collateralId_;
        for (uint256 i = 0; i < 4; i++) {
            actors.push(makeAddr(string(abi.encodePacked("actor", i))));
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function supplyAndPost(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        amount = bound(amount, 1e18, 100_000e18);
        musd.mint(a, amount);
        vm.startPrank(a);
        musd.approve(address(pool), amount);
        uint256 shares = pool.deposit(amount, a);
        pool.approve(address(vm_), shares);
        vm_.depositCollateral(collateralId, shares);
        vm.stopPrank();
    }

    function borrow(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        VaultManager.RiskSnapshot memory s = vm_.getRiskSnapshot(a);
        if (s.borrowLimit <= s.debtValue + 1e18) return;
        amount = bound(amount, 1, s.borrowLimit - s.debtValue - 1e18);
        if (amount > pool.cash()) return;
        vm.prank(a);
        vm_.borrow(marketId, amount, new bytes[](0));
    }

    function repay(uint256 seed, uint256 amount) external {
        address a = _actor(seed);
        if (pool.borrowBalanceView(a) == 0) return;
        amount = bound(amount, 1, 200_000e18);
        musd.mint(a, amount);
        vm.startPrank(a);
        musd.approve(address(vm_), amount);
        vm_.repay(marketId, amount, a);
        vm.stopPrank();
    }

    function withdrawCollateral(uint256 seed, uint256 shares) external {
        address a = _actor(seed);
        uint256 bal = vm_.collateralBalance(a, collateralId);
        if (bal == 0) return;
        shares = bound(shares, 1, bal);
        vm.prank(a);
        try vm_.withdrawCollateral(collateralId, shares, a, new bytes[](0)) {} catch {}
    }

    function warp(uint256 secs) external {
        secs = bound(secs, 1, 30 days);
        skip(secs);
        warps++;
        // Keep oracle prices fresh so risk-checked actions remain callable.
        fixture.refreshPrices();
    }
}

interface HubFixtureView {
    function refreshPrices() external;
}

contract PoolInvariantTest is HubFixture {
    PoolHandler internal handler;

    function setUp() public {
        setUpHub();
        handler = new PoolHandler(pMUSD, vaultManager, musdMarket, pMusdCollateral);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = PoolHandler.supplyAndPost.selector;
        selectors[1] = PoolHandler.borrow.selector;
        selectors[2] = PoolHandler.repay.selector;
        selectors[3] = PoolHandler.withdrawCollateral.selector;
        selectors[4] = PoolHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function refreshPrices() external {
        pushPrices();
    }

    function afterInvariant() external view {
        // Sanity: the campaign actually moved time forward (interest accrued).
        assertGt(handler.warps(), 0);
    }

    function invariant_poolSolvent() public view {
        assertGe(pMUSD.cash() + pMUSD.totalBorrows(), pMUSD.totalReserves());
    }

    function invariant_debtsMatchTotalBorrows() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            sum += pMUSD.borrowBalanceStored(handler.actors(i));
        }
        uint256 total = pMUSD.totalBorrows();
        // Individual debts round up: they may exceed the aggregate only by a few wei per account.
        assertLe(sum, total + handler.actorCount() * 2);
        // The aggregate may keep phantom dust from index truncation (Compound-style); bound it.
        assertLe(total - (sum > total ? total : sum), total / 1e9 + 1e9);
    }

    function invariant_escrowMatchesAccounting() public view {
        assertEq(pMUSD.balanceOf(address(vaultManager)), vaultManager.totalCollateral(pMusdCollateral));
    }
}
