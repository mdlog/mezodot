// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {HubFixture} from "./HubFixture.sol";
import {VaaSigner} from "./VaaSigner.sol";
import {DevWormhole} from "../mocks/DevWormhole.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {IWormhole} from "../../src/interfaces/IWormhole.sol";
import {WormholeAdapter} from "../../src/hub/WormholeAdapter.sol";
import {SpokeGateway} from "../../src/spoke/SpokeGateway.sol";
import {Payload} from "../../src/libraries/Payload.sol";

/// @notice Hub + one Base Sepolia spoke in a single EVM, each with its own dev Wormhole core.
///         `relayLast` turns the most recent LogMessagePublished into a guardian-signed VAA.
abstract contract CrossChainFixture is HubFixture {
    uint16 internal constant MEZO_CHAIN = 50;
    uint256 internal constant GUARDIAN_PK = 0x6A4D;

    DevWormhole internal hubWormhole;
    DevWormhole internal spokeWormhole;
    WormholeAdapter internal adapter;
    SpokeGateway internal spoke;
    MockERC20 internal weth;
    MockERC20 internal usdc;

    function setUpCrossChain() internal {
        setUpHub();
        hubWormhole = new DevWormhole(MEZO_CHAIN, vm.addr(GUARDIAN_PK), 0);
        spokeWormhole = new DevWormhole(BASE_SEPOLIA, vm.addr(GUARDIAN_PK), 0);

        // Spoke tokens live at the addresses the hub collateral registry expects.
        deployCodeTo(
            "MockERC20.sol:MockERC20",
            abi.encode("Wrapped Ether", "WETH", uint8(18)),
            address(uint160(uint256(SPOKE_WETH)))
        );
        deployCodeTo(
            "MockERC20.sol:MockERC20", abi.encode("USD Coin", "USDC", uint8(6)), address(uint160(uint256(SPOKE_USDC)))
        );
        weth = MockERC20(address(uint160(uint256(SPOKE_WETH))));
        usdc = MockERC20(address(uint160(uint256(SPOKE_USDC))));

        adapter = new WormholeAdapter(hubWormhole, vaultManager, 1, address(this));
        vaultManager.setAdapter(address(adapter));
        spoke = new SpokeGateway(spokeWormhole, MEZO_CHAIN, 1, address(this));
        spoke.setToken(address(weth), true, type(uint256).max);
        spoke.setToken(address(usdc), true, type(uint256).max);

        adapter.setSpoke(BASE_SEPOLIA, Payload.toBytes32(address(spoke)));
        spoke.setHubEmitter(Payload.toBytes32(address(adapter)));
    }

    /// Deposits `amount` of `token` on the spoke as `who` and returns the signed VAA for the hub.
    function spokeDeposit(address who, MockERC20 token, uint256 amount) internal returns (bytes memory vaa) {
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(spoke), amount);
        vm.recordLogs();
        spoke.deposit(address(token), amount);
        vm.stopPrank();
        vaa = signLast(BASE_SEPOLIA, address(spoke));
    }

    /// Signs the last LogMessagePublished emitted by `emitter` as a VAA from `chainId`.
    function signLast(uint16 chainId, address emitter) internal returns (bytes memory) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory l = logs[i - 1];
            if (l.topics[0] != IWormhole.LogMessagePublished.selector) continue;
            if (address(uint160(uint256(l.topics[1]))) != emitter) continue;
            (uint64 sequence,, bytes memory payload,) = abi.decode(l.data, (uint64, uint32, bytes, uint8));
            return VaaSigner.sign(vm, GUARDIAN_PK, 0, chainId, Payload.toBytes32(emitter), sequence, payload);
        }
        revert("no message published");
    }

    function signRaw(uint16 chainId, address emitter, uint64 sequence, bytes memory payload)
        internal
        pure
        returns (bytes memory)
    {
        return VaaSigner.sign(vm, GUARDIAN_PK, 0, chainId, Payload.toBytes32(emitter), sequence, payload);
    }
}
