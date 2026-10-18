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
/// Env: MODE, HUB_NETWORK, SPOKE_NETWORK (deployment JSON names), FORCE_REPOINT (default false).
/// Re-runnable: an emitter already set to the same address is left alone, and a live link is only re-pointed
/// with FORCE_REPOINT=1 (a stale JSON must not redirect a gateway); existing remote collateral is reconciled
/// to the risk parameters below instead of being skipped.
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
            if (_repoint(WormholeAdapter(adapter).spokeEmitter(spokeChain), Payload.toBytes32(gateway))) {
                WormholeAdapter(adapter).setSpoke(spokeChain, Payload.toBytes32(gateway));
            }
            _addRemote(
                vaultManager, spokeChain, vm.parseJsonAddress(spokeJson, ".tokens.WETH"), 18, "ETH", 7500, 8000, 700
            );
            _addRemote(
                vaultManager, spokeChain, vm.parseJsonAddress(spokeJson, ".tokens.USDC"), 6, "USDC", 8000, 8500, 500
            );
            console2.log("hub linked to spoke chain", spokeChain);
        } else {
            // A spoke built for another hub chain would emit DEPOSITs the hub always rejects (funds stuck).
            require(
                SpokeGateway(gateway).hubChainId() == uint16(vm.parseJsonUint(hubJson, ".wormholeChainId")),
                "ConfigureCrossChain: spoke hubChainId does not match the hub deployment"
            );
            if (_repoint(SpokeGateway(gateway).hubEmitter(), Payload.toBytes32(adapter))) {
                SpokeGateway(gateway).setHubEmitter(Payload.toBytes32(adapter));
            }
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
        uint256 listed = vaultManager.remoteCollateralId(chainId, remote);
        if (listed != 0) {
            VaultManager.CollateralConfig memory c = vaultManager.collaterals(listed - 1);
            if (c.ltvBps == ltv && c.ltBps == lt && c.bonusBps == bonus) return;
            console2.log("reconciling risk parameters of collateral", listed - 1);
            vaultManager.setCollateralParams(listed - 1, ltv, lt, bonus, c.cap, c.enabled);
            return;
        }
        vaultManager.addCollateral(
            VaultManager.CollateralConfig({
                enabled: true,
                isRemote: true,
                isShare: false,
                token: address(0),
                chainId: chainId,
                remoteToken: remote,
                decimals: decimals,
                priceKey: keccak256(bytes(priceSymbol)),
                ltvBps: ltv,
                ltBps: lt,
                bonusBps: bonus,
                // Remote deposits are capped where the tokens are locked: SpokeGateway.setToken (DeploySpoke).
                cap: type(uint256).max
            })
        );
    }

    /// Whether to (re)write an emitter: not when it already matches, and over a different live one only on request.
    function _repoint(bytes32 current, bytes32 wanted) internal view returns (bool) {
        if (current == wanted) return false;
        require(current == bytes32(0) || vm.envOr("FORCE_REPOINT", false), "ConfigureCrossChain: set FORCE_REPOINT=1");
        return true;
    }

    function _read(string memory network) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", network, ".json"));
    }
}
