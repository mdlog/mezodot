// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {WormholeAdapter} from "../src/hub/WormholeAdapter.sol";
import {KeeperGateway} from "../src/hub/KeeperGateway.sol";

/// @notice Deploys a new KeeperGateway on an existing hub and records it in
///         packages/sdk/src/deployments/<NETWORK>.json. The gateway holds no privileges or funds (liquidations and
///         relays are permissionless), so replacing it needs no migration; its keeper statistics start from zero.
/// Env: NETWORK.
contract DeployKeeperGateway is Script {
    using stdJson for string;

    function run() external returns (KeeperGateway gateway) {
        string memory path =
            string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", vm.envString("NETWORK"), ".json");
        string memory json = vm.readFile(path);
        VaultManager vaultManager = VaultManager(json.readAddress(".contracts.vaultManager"));
        WormholeAdapter adapter = WormholeAdapter(json.readAddress(".contracts.wormholeAdapter"));
        require(address(adapter.vaultManager()) == address(vaultManager), "DeployKeeperGateway: adapter/hub mismatch");

        vm.startBroadcast();
        gateway = new KeeperGateway(vaultManager, adapter);
        vm.stopBroadcast();

        string[] memory keys = vm.parseJsonKeys(json, ".contracts");
        string memory obj = "contracts";
        string memory contracts;
        for (uint256 i = 0; i < keys.length; i++) {
            contracts = vm.serializeAddress(obj, keys[i], json.readAddress(string.concat(".contracts.", keys[i])));
        }
        contracts = vm.serializeAddress(obj, "keeperGateway", address(gateway));
        // A dry run never overwrites the deployment record (see DeployHub).
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.writeJson(contracts, path, ".contracts");
        } else {
            console2.log("dry run: deployment not written to", path);
        }
        console2.log("KeeperGateway", address(gateway));
    }
}
