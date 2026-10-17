// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {InterestRateModel} from "../src/hub/InterestRateModel.sol";
import {PToken} from "../src/hub/PToken.sol";
import {OracleRouter} from "../src/hub/OracleRouter.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {WormholeAdapter} from "../src/hub/WormholeAdapter.sol";
import {LeverageManager} from "../src/hub/LeverageManager.sol";
import {KeeperGateway} from "../src/hub/KeeperGateway.sol";

/// @notice Deploys the Mezo hub. Remote (spoke) collateral is registered later by ConfigureCrossChain.
/// Env: NETWORK, MUSD, MEZO, PYTH, WORMHOLE, MUSD_FEED, MEZO_FEED, ETH_FEED, USDC_FEED,
///      CONSISTENCY_LEVEL (default 1), SEED_AMOUNT (default 1e18; 0 disables the seed deposit).
/// Writes packages/sdk/src/deployments/<NETWORK>.json.
contract DeployHub is Script {
    struct Deployed {
        address oracle;
        address vaultManager;
        address adapter;
        address leverageManager;
        address keeperGateway;
        address pMUSD;
        address pMEZO;
    }

    function run() external returns (Deployed memory d) {
        string memory network = vm.envString("NETWORK");
        address musd = vm.envAddress("MUSD");
        address mezo = vm.envAddress("MEZO");
        uint256 startBlock = block.number;

        vm.startBroadcast();
        address owner = msg.sender;

        OracleRouter oracle = new OracleRouter(IPyth(vm.envAddress("PYTH")), 120, 200, owner);
        oracle.setFeed(keccak256("MUSD"), vm.envBytes32("MUSD_FEED"));
        oracle.setFeed(keccak256("MEZO"), vm.envBytes32("MEZO_FEED"));
        oracle.setFeed(keccak256("ETH"), vm.envBytes32("ETH_FEED"));
        oracle.setFeed(keccak256("USDC"), vm.envBytes32("USDC_FEED"));

        // Rates from the spec: MUSD 0/6%/80%/80%, MEZO 2%/8%/70%/100%, reserve factor 10%.
        PToken pMUSD = new PToken(
            IERC20(musd), "Mezodot MUSD", "pMUSD", new InterestRateModel(0, 0.06e18, 0.8e18, 0.8e18), 0.1e18, owner
        );
        PToken pMEZO = new PToken(
            IERC20(mezo), "Mezodot MEZO", "pMEZO", new InterestRateModel(0.02e18, 0.08e18, 0.7e18, 1e18), 0.1e18, owner
        );

        VaultManager vaultManager = new VaultManager(oracle, owner);
        pMUSD.setVaultManager(address(vaultManager));
        pMEZO.setVaultManager(address(vaultManager));
        uint256 musdMarket = vaultManager.addMarket(pMUSD, keccak256("MUSD"));
        vaultManager.addMarket(pMEZO, keccak256("MEZO"));
        uint256 pMusdCollateral = vaultManager.addCollateral(_local(address(pMUSD), keccak256("MUSD"), 8000, 8500, 500));
        vaultManager.addCollateral(_local(address(pMEZO), keccak256("MEZO"), 5000, 6000, 1000));

        WormholeAdapter adapter = new WormholeAdapter(
            IWormhole(vm.envAddress("WORMHOLE")), vaultManager, uint8(vm.envOr("CONSISTENCY_LEVEL", uint256(1))), owner
        );
        vaultManager.setAdapter(address(adapter));
        LeverageManager lev = new LeverageManager(vaultManager, pMUSD, musdMarket, pMusdCollateral);
        KeeperGateway keepers = new KeeperGateway(vaultManager, adapter);

        // Seed deposits (shares sent to a dead address) harden the vaults against share-price games.
        uint256 seed = vm.envOr("SEED_AMOUNT", uint256(1e18));
        if (seed > 0) {
            _seed(pMUSD, musd, seed);
            _seed(pMEZO, mezo, seed);
        }
        vm.stopBroadcast();

        d = Deployed(
            address(oracle),
            address(vaultManager),
            address(adapter),
            address(lev),
            address(keepers),
            address(pMUSD),
            address(pMEZO)
        );
        _write(network, d, musd, mezo, startBlock);
    }

    function _local(address token, bytes32 priceKey, uint16 ltv, uint16 lt, uint16 bonus)
        internal
        pure
        returns (VaultManager.CollateralConfig memory)
    {
        return VaultManager.CollateralConfig({
            enabled: true,
            isRemote: false,
            token: token,
            chainId: 0,
            remoteToken: bytes32(0),
            decimals: 18,
            priceKey: priceKey,
            ltvBps: ltv,
            ltBps: lt,
            bonusBps: bonus,
            cap: type(uint256).max
        });
    }

    function _seed(PToken pool, address token, uint256 amount) internal {
        IERC20(token).approve(address(pool), amount);
        pool.deposit(amount, address(0xdead));
    }

    function _write(string memory network, Deployed memory d, address musd, address mezo, uint256 startBlock) internal {
        string memory c = "contracts";
        vm.serializeAddress(c, "oracleRouter", d.oracle);
        vm.serializeAddress(c, "vaultManager", d.vaultManager);
        vm.serializeAddress(c, "wormholeAdapter", d.adapter);
        vm.serializeAddress(c, "leverageManager", d.leverageManager);
        vm.serializeAddress(c, "keeperGateway", d.keeperGateway);
        vm.serializeAddress(c, "pMUSD", d.pMUSD);
        vm.serializeAddress(c, "pMEZO", d.pMEZO);
        vm.serializeAddress(c, "wormhole", vm.envAddress("WORMHOLE"));
        string memory contracts = vm.serializeAddress(c, "pyth", vm.envAddress("PYTH"));

        string memory t = "tokens";
        vm.serializeAddress(t, "MUSD", musd);
        string memory tokens = vm.serializeAddress(t, "MEZO", mezo);

        string memory f = "priceFeeds";
        vm.serializeBytes32(f, "MUSD", vm.envBytes32("MUSD_FEED"));
        vm.serializeBytes32(f, "MEZO", vm.envBytes32("MEZO_FEED"));
        vm.serializeBytes32(f, "ETH", vm.envBytes32("ETH_FEED"));
        string memory feeds = vm.serializeBytes32(f, "USDC", vm.envBytes32("USDC_FEED"));

        string memory root = "root";
        vm.serializeString(root, "network", network);
        vm.serializeString(root, "role", "hub");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeUint(root, "wormholeChainId", IWormhole(vm.envAddress("WORMHOLE")).chainId());
        vm.serializeUint(root, "startBlock", startBlock);
        vm.serializeString(root, "contracts", contracts);
        vm.serializeString(root, "priceFeeds", feeds);
        string memory json = vm.serializeString(root, "tokens", tokens);
        string memory path = string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", network, ".json");
        vm.writeJson(json, path);
        console2.log("hub deployment written to", path);
    }
}
