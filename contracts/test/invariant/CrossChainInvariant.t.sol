// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CrossChainFixture} from "../utils/CrossChainFixture.sol";
import {Payload} from "../../src/libraries/Payload.sol";

/// Random spoke deposits, hub withdrawals and (possibly delayed) message delivery.
contract CrossChainInvariantTest is CrossChainFixture {
    bytes[] internal pendingDeposits;
    bytes[] internal pendingReleases;
    address[] internal users;

    function setUp() public {
        setUpCrossChain();
        users.push(makeAddr("u0"));
        users.push(makeAddr("u1"));
        users.push(makeAddr("u2"));
        targetContract(address(this));
        bytes4[] memory selectors = new bytes4[](4);
        selectors[0] = this.handlerDeposit.selector;
        selectors[1] = this.handlerRelayDeposit.selector;
        selectors[2] = this.handlerWithdraw.selector;
        selectors[3] = this.handlerRelayRelease.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
    }

    function handlerDeposit(uint256 seed, uint256 amount) external {
        amount = bound(amount, 1, 100e18);
        pendingDeposits.push(spokeDeposit(users[seed % users.length], weth, amount));
    }

    function handlerRelayDeposit(uint256 seed) external {
        if (pendingDeposits.length == 0) return;
        uint256 i = seed % pendingDeposits.length;
        bytes memory vaa = pendingDeposits[i];
        pendingDeposits[i] = pendingDeposits[pendingDeposits.length - 1];
        pendingDeposits.pop();
        adapter.receiveMessage(vaa);
    }

    function handlerWithdraw(uint256 seed, uint256 amount) external {
        address u = users[seed % users.length];
        uint256 bal = vaultManager.collateralBalance(u, wethBase);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.recordLogs();
        vm.prank(u);
        vaultManager.withdrawRemote(wethBase, amount, Payload.toBytes32(u), noUpdates());
        pendingReleases.push(signLast(MEZO_CHAIN, address(adapter)));
    }

    function handlerRelayRelease(uint256 seed) external {
        if (pendingReleases.length == 0) return;
        uint256 i = seed % pendingReleases.length;
        bytes memory vaa = pendingReleases[i];
        pendingReleases[i] = pendingReleases[pendingReleases.length - 1];
        pendingReleases.pop();
        spoke.receiveMessage(vaa);
    }

    /// Hub credit can never exceed what is actually locked on the spoke.
    function invariant_hubCreditBackedBySpoke() public view {
        assertLe(vaultManager.totalCollateral(wethBase), spoke.locked(address(weth)));
    }

    function invariant_spokeHoldsLockedTokens() public view {
        assertEq(weth.balanceOf(address(spoke)), spoke.locked(address(weth)));
    }
}
