// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";

/// VaultManager, PToken and SpokeGateway all use OpenZeppelin's Pausable behind onlyOwner.
interface IPausable {
    function paused() external view returns (bool);
    function pause() external;
    function unpause() external;
}

/// @notice Incident switch (docs/RUNBOOK.md). Run on the hub, then on each spoke, with the owner key.
///   MODE=hub:   VaultManager (borrows) and both pools (supply, loops/flash loans).
///   MODE=spoke: the SpokeGateway (new deposits).
/// Pausing never blocks exits or risk reduction: repay, withdraw, liquidations, DEPOSIT credits for tokens
/// already locked, and RELEASEs keep working.
/// Env: MODE (hub|spoke), NETWORK (deployment JSON name), ACTION (pause|unpause, default pause).
contract Pause is Script {
    function run() external {
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", vm.envString("NETWORK"), ".json")
        );
        bool pause = keccak256(bytes(vm.envOr("ACTION", string("pause")))) == keccak256("pause");
        vm.startBroadcast();
        if (keccak256(bytes(vm.envString("MODE"))) == keccak256("hub")) {
            _set(vm.parseJsonAddress(json, ".contracts.vaultManager"), pause);
            _set(vm.parseJsonAddress(json, ".contracts.pMUSD"), pause);
            _set(vm.parseJsonAddress(json, ".contracts.pMEZO"), pause);
        } else {
            _set(vm.parseJsonAddress(json, ".contracts.spokeGateway"), pause);
        }
        vm.stopBroadcast();
    }

    function _set(address target, bool pause) internal {
        if (IPausable(target).paused() == pause) {
            console2.log(target, pause ? "already paused" : "already unpaused");
            return;
        }
        if (pause) IPausable(target).pause();
        else IPausable(target).unpause();
        console2.log(target, pause ? "paused" : "unpaused");
    }
}
