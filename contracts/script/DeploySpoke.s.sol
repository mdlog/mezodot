// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {SpokeGateway} from "../src/spoke/SpokeGateway.sol";

/// @notice Deploys a SpokeGateway on an external chain and allowlists WETH + USDC.
/// Env: NETWORK, WORMHOLE, WETH, USDC, WORMHOLE_CHAIN_ID (optional cross-check; the id is read from Wormhole Core),
///      HUB_CHAIN_ID (default: the hub deployment's wormholeChainId when HUB_NETWORK is set, else 50),
///      CONSISTENCY_LEVEL (default 1), WETH_CAP [100 WETH], USDC_CAP [250,000 USDC] (token wei, per spoke).
/// Writes packages/sdk/src/deployments/<NETWORK>.json.
contract DeploySpoke is Script {
    function run() external returns (SpokeGateway gateway) {
        string memory network = vm.envString("NETWORK");
        address weth = vm.envAddress("WETH");
        address usdc = vm.envAddress("USDC");
        uint256 startBlock = block.number;
        // The spoke's identity comes from Wormhole Core itself, never from hand-typed config.
        uint16 wormholeChainId = IWormhole(vm.envAddress("WORMHOLE")).chainId();
        uint256 expected = vm.envOr("WORMHOLE_CHAIN_ID", uint256(wormholeChainId));
        require(expected == wormholeChainId, "WORMHOLE_CHAIN_ID does not match Wormhole Core chainId()");
        uint16 hubChainId = _hubChainId();

        vm.startBroadcast();
        // The broadcaster, whatever the signer type: with --account/--keystore and no --sender,
        // msg.sender here is forge's default sender, which would own the gateway.
        (, address owner,) = vm.readCallers();
        gateway = new SpokeGateway(
            IWormhole(vm.envAddress("WORMHOLE")), hubChainId, uint8(vm.envOr("CONSISTENCY_LEVEL", uint256(1))), owner
        );
        // Remote collateral is capped here, where it is locked: the hub credits whatever a VAA proves.
        gateway.setToken(weth, true, vm.envOr("WETH_CAP", uint256(100e18)));
        gateway.setToken(usdc, true, vm.envOr("USDC_CAP", uint256(250_000e6)));
        vm.stopBroadcast();

        string memory c = "contracts";
        vm.serializeAddress(c, "spokeGateway", address(gateway));
        string memory contracts = vm.serializeAddress(c, "wormhole", vm.envAddress("WORMHOLE"));
        string memory t = "tokens";
        vm.serializeAddress(t, "WETH", weth);
        string memory tokens = vm.serializeAddress(t, "USDC", usdc);

        string memory root = "root";
        vm.serializeString(root, "network", network);
        vm.serializeString(root, "role", "spoke");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "wormholeChainId", wormholeChainId);
        vm.serializeUint(root, "startBlock", startBlock);
        vm.serializeString(root, "contracts", contracts);
        string memory json = vm.serializeString(root, "tokens", tokens);
        string memory path = string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", network, ".json");
        vm.writeJson(json, path);
        console2.log("spoke deployment written to", path);
    }

    /// The hub's Wormhole chain id; a mismatch would make every DEPOSIT from this spoke unclaimable.
    function _hubChainId() internal view returns (uint16) {
        string memory hub = vm.envOr("HUB_NETWORK", string(""));
        if (bytes(hub).length == 0) return uint16(vm.envOr("HUB_CHAIN_ID", uint256(50)));
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", hub, ".json"));
        uint16 fromHub = uint16(vm.parseJsonUint(json, ".wormholeChainId"));
        require(vm.envOr("HUB_CHAIN_ID", uint256(fromHub)) == fromHub, "HUB_CHAIN_ID does not match the hub deployment");
        return fromHub;
    }
}
