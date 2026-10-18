// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {InterestRateModel} from "../src/hub/InterestRateModel.sol";
import {PToken} from "../src/hub/PToken.sol";
import {OracleRouter} from "../src/hub/OracleRouter.sol";
import {PythSource} from "../src/oracle/PythSource.sol";
import {SupraSource, ISupraOraclePull} from "../src/oracle/SupraSource.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {WormholeAdapter} from "../src/hub/WormholeAdapter.sol";
import {LeverageManager} from "../src/hub/LeverageManager.sol";
import {KeeperGateway} from "../src/hub/KeeperGateway.sol";

/// @notice Deploys the Mezo hub. Remote (spoke) collateral is registered later by ConfigureCrossChain.
/// Env: NETWORK, MUSD, MEZO, WORMHOLE, CONSISTENCY_LEVEL (default 1), SEED_AMOUNT (default 1e18; 0 = none).
///      Oracle: PYTH (Pyth Core), SUPRA_PULL (optional Supra DORA pull contract), and per symbol
///      (MUSD, MEZO, ETH, USDC): <SYM>_FEED (Pyth price id), <SYM>_MAX_AGE (Pyth leg, default 120 s),
///      <SYM>_MAX_CONF_BPS (default 200), <SYM>_SUPRA_PAIR (optional secondary leg),
///      SUPRA_MAX_AGE (default 120 s), DIVERGENCE_BPS (two-leg cross-check, default 150).
/// Writes packages/sdk/src/deployments/<NETWORK>.json.
contract DeployHub is Script {
    /// OracleRouter source tags; mirrored by SOURCE_TAG in packages/sdk/src/oracle.ts.
    uint8 internal constant PYTH_TAG = 1;
    uint8 internal constant SUPRA_TAG = 2;
    uint256 internal constant UNSET = type(uint256).max;
    /// Mezo precompiles live at 0x7b7c…; MEZO itself is 0x7b7c000000000000000000000000000000000001.
    uint160 internal constant MEZO_PRECOMPILE_PREFIX = uint160(0x7b7C000000000000000000000000000000000000) >> 32;

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

        _mockPrecompileToken(mezo);
        vm.startBroadcast();
        // The broadcaster, whatever the signer type: with --account/--keystore and no --sender,
        // msg.sender here is forge's default sender, which would own every contract.
        (, address owner,) = vm.readCallers();

        OracleRouter oracle = _deployOracle(owner);

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

    /// @dev MEZO on Mezo is a precompile: forge's local EVM only sees a stub that cannot execute it, so the
    ///      local run mocks the ERC-20 calls this script makes (decimals in PToken/addMarket, the seed's
    ///      approve/transferFrom/balanceOf). Broadcast with --skip-simulation (docs/DEPLOY.md): transactions
    ///      then execute on the node against the real precompile. MEZO has 18 decimals (cast call decimals()).
    function _mockPrecompileToken(address token) internal {
        if (uint160(token) >> 32 != MEZO_PRECOMPILE_PREFIX) return;
        uint8 decimals = uint8(vm.envOr("MEZO_DECIMALS", uint256(18)));
        vm.mockCall(token, abi.encodeWithSelector(IERC20Metadata.decimals.selector), abi.encode(decimals));
        vm.mockCall(token, abi.encodeWithSelector(IERC20.approve.selector), abi.encode(true));
        vm.mockCall(token, abi.encodeWithSelector(IERC20.transferFrom.selector), abi.encode(true));
        vm.mockCall(token, abi.encodeWithSelector(IERC20.balanceOf.selector), abi.encode(uint256(0)));
        console2.log("MEZO is a Mezo precompile: simulation mocks its ERC-20 calls; broadcast with --skip-simulation");
    }

    function _deployOracle(address owner) internal returns (OracleRouter oracle) {
        oracle = new OracleRouter(owner);
        oracle.setSource(PYTH_TAG, new PythSource(IPyth(vm.envAddress("PYTH"))));
        address supraPull = vm.envOr("SUPRA_PULL", address(0));
        if (supraPull != address(0)) oracle.setSource(SUPRA_TAG, new SupraSource(ISupraOraclePull(supraPull)));
        _setFeed(oracle, "MUSD", supraPull != address(0));
        _setFeed(oracle, "MEZO", supraPull != address(0));
        _setFeed(oracle, "ETH", supraPull != address(0));
        _setFeed(oracle, "USDC", supraPull != address(0));
    }

    /// Pyth primary leg per symbol, plus a Supra secondary leg when <SYM>_SUPRA_PAIR is set.
    function _setFeed(OracleRouter oracle, string memory sym, bool supra) internal {
        uint256 pair = supra ? vm.envOr(string.concat(sym, "_SUPRA_PAIR"), UNSET) : UNSET;
        OracleRouter.Leg memory secondary;
        if (pair != UNSET) {
            secondary = OracleRouter.Leg(SUPRA_TAG, uint32(vm.envOr("SUPRA_MAX_AGE", uint256(120))), bytes32(pair));
        }
        oracle.setFeed(
            keccak256(bytes(sym)),
            OracleRouter.Feed({
                primary: OracleRouter.Leg(
                    PYTH_TAG,
                    uint32(vm.envOr(string.concat(sym, "_MAX_AGE"), uint256(120))),
                    vm.envBytes32(string.concat(sym, "_FEED"))
                ),
                secondary: secondary,
                maxConfBps: uint16(vm.envOr(string.concat(sym, "_MAX_CONF_BPS"), uint256(200))),
                maxDivergenceBps: pair == UNSET ? 0 : uint16(vm.envOr("DIVERGENCE_BPS", uint256(150)))
            })
        );
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
        vm.serializeAddress(c, "supraPull", vm.envOr("SUPRA_PULL", address(0)));
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
