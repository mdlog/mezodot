// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PToken} from "../src/hub/PToken.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {SwapLeverageManager} from "../src/hub/SwapLeverageManager.sol";
import {ITigrisPool, ITigrisPoolFactory} from "../src/interfaces/ITigrisPool.sol";

/// @notice Deploys a new SwapLeverageManager on an existing hub and records it in
///         packages/sdk/src/deployments/<NETWORK>.json. It holds no funds or state, so replacing it needs no
///         migration: users authorise the new address once (VaultManager.setOperator) and approve BTC to it.
/// Env: NETWORK, TIGRIS_STABLE (default false: the volatile MUSD/BTC pool).
contract DeploySwapLeverage is Script {
    using stdJson for string;

    function run() external returns (SwapLeverageManager manager) {
        string memory path =
            string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", vm.envString("NETWORK"), ".json");
        string memory json = vm.readFile(path);
        VaultManager vaultManager = VaultManager(json.readAddress(".contracts.vaultManager"));
        PToken pMUSD = PToken(json.readAddress(".contracts.pMUSD"));
        address btc = json.readAddress(".tokens.BTC");
        ITigrisPool pair = ITigrisPool(
            ITigrisPoolFactory(json.readAddress(".contracts.tigrisFactory"))
                .getPool(pMUSD.asset(), btc, vm.envOr("TIGRIS_STABLE", false))
        );
        require(address(pair) != address(0), "DeploySwapLeverage: no Tigris MUSD/BTC pool");

        vm.startBroadcast();
        manager = new SwapLeverageManager(
            vaultManager, pMUSD, _marketOf(vaultManager, pMUSD), _collateralOf(vaultManager, btc), pair
        );
        vm.stopBroadcast();

        // Rewrites the contracts object with every recorded address, the new manager and its pool.
        string[] memory keys = vm.parseJsonKeys(json, ".contracts");
        string memory obj = "contracts";
        for (uint256 i = 0; i < keys.length; i++) {
            vm.serializeAddress(obj, keys[i], json.readAddress(string.concat(".contracts.", keys[i])));
        }
        vm.serializeAddress(obj, "tigrisPool", address(pair));
        string memory contracts = vm.serializeAddress(obj, "swapLeverageManager", address(manager));
        // A dry run never overwrites the deployment record (see DeployHub).
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.writeJson(contracts, path, ".contracts");
        } else {
            console2.log("dry run: deployment not written to", path);
        }
        console2.log("SwapLeverageManager", address(manager));
        console2.log("Tigris pool", address(pair));
    }

    function _marketOf(VaultManager vaultManager, PToken pool) internal view returns (uint256 id) {
        for (; id < vaultManager.marketCount(); id++) {
            if (address(vaultManager.markets(id).pool) == address(pool)) return id;
        }
        revert("DeploySwapLeverage: MUSD market not found");
    }

    function _collateralOf(VaultManager vaultManager, address token) internal view returns (uint256 id) {
        for (; id < vaultManager.collateralCount(); id++) {
            VaultManager.CollateralConfig memory c = vaultManager.collaterals(id);
            if (c.token == token && !c.isRemote && !c.isShare) return id;
        }
        revert("DeploySwapLeverage: BTC collateral not found");
    }
}
