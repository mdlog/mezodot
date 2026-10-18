// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdStorage, stdStorage} from "forge-std/Test.sol";
import {CrossChainFixture} from "./CrossChainFixture.sol";

/// @notice CrossChainFixture with a non-zero Wormhole message fee on the hub, so every hub → spoke RELEASE (remote
///         withdrawals and liquidations of remote collateral) has to be paid for out of msg.value.
/// @dev DevWormhole takes its fee only in the constructor and setUpCrossChain deploys the hub core with 0, so the fee
///      is written in place: the rest of the cross-chain setup stays exactly the shared one.
abstract contract MessageFeeFixture is CrossChainFixture {
    using stdStorage for StdStorage;

    function setUpCrossChainWithHubFee(uint256 fee) internal {
        setUpCrossChain();
        stdstore.target(address(hubWormhole)).sig(hubWormhole.messageFee.selector).checked_write(fee);
        // The adapter (and so VaultManager) reads the fee live from Wormhole Core.
        assertEq(adapter.messageFee(), fee, "hub message fee");
    }
}
