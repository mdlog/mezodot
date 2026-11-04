// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PToken} from "../src/hub/PToken.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {TroveRouter} from "../src/hub/TroveRouter.sol";
import {IBorrowerOperationsSignatures} from "../src/interfaces/IBorrowerOperationsSignatures.sol";

/// @notice Deploys TroveRouter on an existing hub and records it, with the Mezo trove contracts apps read, in
///         packages/sdk/src/deployments/<NETWORK>.json. It holds no funds or state, so replacing it needs no migration.
/// Env: NETWORK, and Mezo's MUSD system: MEZO_BORROWER_OPERATIONS, MEZO_BORROWER_SIGNATURES, MEZO_TROVE_MANAGER,
///      MEZO_HINT_HELPERS, MEZO_SORTED_TROVES, MEZO_PRICE_FEED, MEZO_COLL_SURPLUS_POOL.
contract DeployTroveRouter is Script {
    using stdJson for string;

    function run() external returns (TroveRouter router) {
        string memory path =
            string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", vm.envString("NETWORK"), ".json");
        string memory json = vm.readFile(path);
        VaultManager vaultManager = VaultManager(json.readAddress(".contracts.vaultManager"));
        PToken pMUSD = PToken(json.readAddress(".contracts.pMUSD"));
        address signatures = vm.envAddress("MEZO_BORROWER_SIGNATURES");

        vm.startBroadcast();
        router = new TroveRouter(
            IBorrowerOperationsSignatures(signatures), vaultManager, pMUSD, _collateralOf(vaultManager, pMUSD)
        );
        vm.stopBroadcast();

        string[] memory keys = vm.parseJsonKeys(json, ".contracts");
        string memory obj = "contracts";
        for (uint256 i = 0; i < keys.length; i++) {
            vm.serializeAddress(obj, keys[i], json.readAddress(string.concat(".contracts.", keys[i])));
        }
        vm.serializeAddress(obj, "mezoBorrowerOperations", vm.envAddress("MEZO_BORROWER_OPERATIONS"));
        vm.serializeAddress(obj, "mezoBorrowerSignatures", signatures);
        vm.serializeAddress(obj, "mezoTroveManager", vm.envAddress("MEZO_TROVE_MANAGER"));
        vm.serializeAddress(obj, "mezoHintHelpers", vm.envAddress("MEZO_HINT_HELPERS"));
        vm.serializeAddress(obj, "mezoSortedTroves", vm.envAddress("MEZO_SORTED_TROVES"));
        vm.serializeAddress(obj, "mezoPriceFeed", vm.envAddress("MEZO_PRICE_FEED"));
        vm.serializeAddress(obj, "mezoCollSurplusPool", vm.envAddress("MEZO_COLL_SURPLUS_POOL"));
        string memory contracts = vm.serializeAddress(obj, "troveRouter", address(router));
        // A dry run never overwrites the deployment record (see DeployHub).
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.writeJson(contracts, path, ".contracts");
        } else {
            console2.log("dry run: deployment not written to", path);
        }
        console2.log("TroveRouter", address(router));
    }

    function _collateralOf(VaultManager vaultManager, PToken pool) internal view returns (uint256 id) {
        for (; id < vaultManager.collateralCount(); id++) {
            VaultManager.CollateralConfig memory c = vaultManager.collaterals(id);
            if (c.token == address(pool) && c.isShare && !c.isRemote) return id;
        }
        revert("DeployTroveRouter: pMUSD collateral not found");
    }
}
