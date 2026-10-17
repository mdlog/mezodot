// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {WormholeAdapter} from "../src/hub/WormholeAdapter.sol";
import {SpokeGateway} from "../src/spoke/SpokeGateway.sol";
import {Payload} from "../src/libraries/Payload.sol";

/// @notice Links the hub and one spoke in both directions. Run once per spoke, on each chain:
///   MODE=hub   (on Mezo):  registers the spoke emitter and its WETH/USDC as remote collateral.
///   MODE=spoke (on spoke): registers the hub adapter as the only trusted RELEASE emitter.
/// Env: MODE, HUB_NETWORK, SPOKE_NETWORK (deployment JSON names).
contract ConfigureCrossChain is Script {
    function run() external {
        string memory mode = vm.envString("MODE");
        string memory hubJson = _read(vm.envString("HUB_NETWORK"));
        string memory spokeJson = _read(vm.envString("SPOKE_NETWORK"));
        address adapter = vm.parseJsonAddress(hubJson, ".contracts.wormholeAdapter");
        address gateway = vm.parseJsonAddress(spokeJson, ".contracts.spokeGateway");

        vm.startBroadcast();
        if (keccak256(bytes(mode)) == keccak256("hub")) {
            uint16 spokeChain = uint16(vm.parseJsonUint(spokeJson, ".wormholeChainId"));
            VaultManager vaultManager = WormholeAdapter(adapter).vaultManager();
            WormholeAdapter(adapter).setSpoke(spokeChain, Payload.toBytes32(gateway));
            _addRemote(
                vaultManager, spokeChain, vm.parseJsonAddress(spokeJson, ".tokens.WETH"), 18, "ETH", 7500, 8000, 700
            );
            _addRemote(
                vaultManager, spokeChain, vm.parseJsonAddress(spokeJson, ".tokens.USDC"), 6, "USDC", 8000, 8500, 500
            );
            console2.log("hub linked to spoke chain", spokeChain);
        } else {
            SpokeGateway(gateway).setHubEmitter(Payload.toBytes32(adapter));
            console2.log("spoke linked to hub adapter", adapter);
        }
        vm.stopBroadcast();
    }

    function _addRemote(
        VaultManager vaultManager,
        uint16 chainId,
        address token,
        uint8 decimals,
        string memory priceSymbol,
        uint16 ltv,
        uint16 lt,
        uint16 bonus
    ) internal {
        bytes32 remote = Payload.toBytes32(token);
        if (vaultManager.remoteCollateralId(chainId, remote) != 0) return; // idempotent
        vaultManager.addCollateral(
            VaultManager.CollateralConfig({
                enabled: true,
                isRemote: true,
                token: address(0),
                chainId: chainId,
                remoteToken: remote,
                decimals: decimals,
                priceKey: keccak256(bytes(priceSymbol)),
                ltvBps: ltv,
                ltBps: lt,
                bonusBps: bonus,
                cap: type(uint256).max
            })
        );
    }

    function _read(string memory network) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", network, ".json"));
    }
}
