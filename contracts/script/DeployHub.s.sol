// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
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
import {SwapLeverageManager} from "../src/hub/SwapLeverageManager.sol";
import {ITigrisPool, ITigrisPoolFactory} from "../src/interfaces/ITigrisPool.sol";

/// @notice Deploys the Mezo hub. Remote (spoke) collateral is registered later by ConfigureCrossChain.
/// Env: NETWORK, MUSD, MEZO, BTC, WORMHOLE, CONSISTENCY_LEVEL (default 1), SEED_AMOUNT (default 1e18; 0 = none).
///      BTC leverage: TIGRIS_FACTORY (the MUSD/BTC pool is looked up there), TIGRIS_STABLE (default false: the
///      volatile pool), TIGRIS_ROUTER (recorded for keeper sales and app quotes).
///      Revenue: LIQUIDATION_FEE_BPS (protocol share of the liquidation bonus, default 1,000 = 10%).
///      Caps (token wei; testnet defaults in brackets): MUSD_SUPPLY_CAP [5M], MUSD_BORROW_CAP [4M],
///      MEZO_SUPPLY_CAP [2B], MEZO_BORROW_CAP [1B], MEZO_COLLATERAL_CAP [100M MEZO], BTC_COLLATERAL_CAP [25 BTC].
///      Oracle: PYTH (Pyth Core), SUPRA_PULL (optional Supra DORA pull contract), and per symbol
///      (MUSD, MEZO, ETH, USDC, BTC): <SYM>_FEED (Pyth price id), <SYM>_MAX_AGE (Pyth leg, default 120 s),
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
        address swapLeverageManager;
        address tigrisPool;
    }

    function run() external returns (Deployed memory d) {
        string memory network = vm.envString("NETWORK");
        address musd = vm.envAddress("MUSD");
        address mezo = vm.envAddress("MEZO");
        address btc = vm.envAddress("BTC");
        uint256 startBlock = block.number;

        _mockPrecompileToken(mezo);
        _mockPrecompileToken(btc);
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

        // Bounded from day one: a thin market (MEZO) or one large depositor cannot take over the hub.
        pMUSD.setCaps(
            vm.envOr("MUSD_SUPPLY_CAP", uint256(5_000_000e18)), vm.envOr("MUSD_BORROW_CAP", uint256(4_000_000e18))
        );
        pMEZO.setCaps(
            vm.envOr("MEZO_SUPPLY_CAP", uint256(2_000_000_000e18)),
            vm.envOr("MEZO_BORROW_CAP", uint256(1_000_000_000e18))
        );

        VaultManager vaultManager = new VaultManager(oracle, owner);
        pMUSD.setVaultManager(address(vaultManager));
        pMEZO.setVaultManager(address(vaultManager));
        uint256 musdMarket = vaultManager.addMarket(pMUSD, keccak256("MUSD"));
        vaultManager.addMarket(pMEZO, keccak256("MEZO"));
        uint256 pMusdCollateral = vaultManager.addCollateral(_local(address(pMUSD), keccak256("MUSD"), 8000, 8500, 500));
        VaultManager.CollateralConfig memory pMezoCollateral =
            _local(address(pMEZO), keccak256("MEZO"), 5000, 6000, 1000);
        // Collateral caps count pool shares; an empty pool mints 10^6 shares per unit (PToken's virtual offset).
        // The share cap is fixed here: as the exchange rate rises it admits slightly less MEZO than the env value.
        uint256 mezoCap = vm.envOr("MEZO_COLLATERAL_CAP", uint256(100_000_000e18));
        pMezoCollateral.cap = mezoCap > type(uint256).max / 1e6 ? type(uint256).max : mezoCap * 1e6;
        vaultManager.addCollateral(pMezoCollateral);
        // BTC held on the hub as a plain token: LTV 70%, liquidation threshold 78%, bonus 5% (≈ 3.3× max leverage).
        VaultManager.CollateralConfig memory btcConfig = _plain(btc, keccak256("BTC"), 7000, 7800, 500);
        btcConfig.cap = vm.envOr("BTC_COLLATERAL_CAP", uint256(25e18));
        uint256 btcCollateral = vaultManager.addCollateral(btcConfig);
        vaultManager.setLiquidationFee(uint16(vm.envOr("LIQUIDATION_FEE_BPS", uint256(1000))));

        WormholeAdapter adapter = new WormholeAdapter(
            IWormhole(vm.envAddress("WORMHOLE")), vaultManager, uint8(vm.envOr("CONSISTENCY_LEVEL", uint256(1))), owner
        );
        vaultManager.setAdapter(address(adapter));
        LeverageManager lev = new LeverageManager(vaultManager, pMUSD, musdMarket, pMusdCollateral);
        KeeperGateway keepers = new KeeperGateway(vaultManager, adapter);
        // Looked up on Tigris' own factory, so the leverage desk cannot be pointed at an arbitrary pool.
        ITigrisPool pair = ITigrisPool(
            ITigrisPoolFactory(vm.envAddress("TIGRIS_FACTORY")).getPool(musd, btc, vm.envOr("TIGRIS_STABLE", false))
        );
        require(address(pair) != address(0), "DeployHub: no Tigris MUSD/BTC pool");
        SwapLeverageManager swapLev = new SwapLeverageManager(vaultManager, pMUSD, musdMarket, btcCollateral, pair);

        // Seed deposits (shares sent to a dead address) harden the vaults against share-price games.
        uint256 seed = vm.envOr("SEED_AMOUNT", uint256(1e18));
        if (seed > 0) {
            _seed(pMUSD, musd, seed);
            // forge does not record mocked calls as transactions, so the precompile's approve would never be sent.
            if (_isMezoPrecompile(mezo)) {
                console2.log("Seed pMEZO with cast after this script (MEZO is a precompile):");
                console2.log("  cast send <MEZO> 'approve(address,uint256)' <pMEZO> <SEED_AMOUNT>");
                console2.log(
                    "  cast send <pMEZO> 'deposit(uint256,address)' <SEED_AMOUNT> 0x000000000000000000000000000000000000dEaD"
                );
            } else {
                _seed(pMEZO, mezo, seed);
            }
        }
        vm.stopBroadcast();

        d = Deployed(
            address(oracle),
            address(vaultManager),
            address(adapter),
            address(lev),
            address(keepers),
            address(pMUSD),
            address(pMEZO),
            address(swapLev),
            address(pair)
        );
        _write(network, d, musd, mezo, btc, startBlock);
    }

    /// @dev MEZO and BTC on Mezo are precompiles: forge's local EVM only sees a stub that cannot execute them,
    ///      so the local run mocks `decimals()` (read by the PToken constructor, addMarket and addCollateral). Broadcast with
    ///      --skip-simulation (docs/DEPLOY.md): transactions then execute on the node against the real
    ///      precompile. Calls the script itself would send to MEZO cannot be mocked (forge would not record
    ///      them), so the pMEZO seed deposit is done with cast. MEZO has 18 decimals (cast call decimals()).
    function _mockPrecompileToken(address token) internal {
        if (!_isMezoPrecompile(token)) return;
        // MEZO and BTC both have 18 decimals (cast call <token> 'decimals()').
        vm.mockCall(token, abi.encodeWithSelector(IERC20Metadata.decimals.selector), abi.encode(uint8(18)));
        console2.log("Mezo precompile", token, "simulation mocks decimals(); broadcast with --skip-simulation");
    }

    function _isMezoPrecompile(address token) internal pure returns (bool) {
        return uint160(token) >> 32 == MEZO_PRECOMPILE_PREFIX;
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
        _setFeed(oracle, "BTC", supraPull != address(0));
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
            isShare: true,
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

    function _plain(address token, bytes32 priceKey, uint16 ltv, uint16 lt, uint16 bonus)
        internal
        pure
        returns (VaultManager.CollateralConfig memory)
    {
        return VaultManager.CollateralConfig({
            enabled: true,
            isRemote: false,
            isShare: false,
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

    function _write(
        string memory network,
        Deployed memory d,
        address musd,
        address mezo,
        address btc,
        uint256 startBlock
    ) internal {
        string memory c = "contracts";
        vm.serializeAddress(c, "oracleRouter", d.oracle);
        vm.serializeAddress(c, "vaultManager", d.vaultManager);
        vm.serializeAddress(c, "wormholeAdapter", d.adapter);
        vm.serializeAddress(c, "leverageManager", d.leverageManager);
        vm.serializeAddress(c, "keeperGateway", d.keeperGateway);
        vm.serializeAddress(c, "pMUSD", d.pMUSD);
        vm.serializeAddress(c, "pMEZO", d.pMEZO);
        vm.serializeAddress(c, "swapLeverageManager", d.swapLeverageManager);
        vm.serializeAddress(c, "tigrisPool", d.tigrisPool);
        vm.serializeAddress(c, "tigrisRouter", vm.envAddress("TIGRIS_ROUTER"));
        vm.serializeAddress(c, "tigrisFactory", vm.envAddress("TIGRIS_FACTORY"));
        vm.serializeAddress(c, "wormhole", vm.envAddress("WORMHOLE"));
        vm.serializeAddress(c, "supraPull", vm.envOr("SUPRA_PULL", address(0)));
        string memory contracts = vm.serializeAddress(c, "pyth", vm.envAddress("PYTH"));

        string memory t = "tokens";
        vm.serializeAddress(t, "MUSD", musd);
        vm.serializeAddress(t, "MEZO", mezo);
        string memory tokens = vm.serializeAddress(t, "BTC", btc);

        string memory f = "priceFeeds";
        vm.serializeBytes32(f, "MUSD", vm.envBytes32("MUSD_FEED"));
        vm.serializeBytes32(f, "MEZO", vm.envBytes32("MEZO_FEED"));
        vm.serializeBytes32(f, "ETH", vm.envBytes32("ETH_FEED"));
        vm.serializeBytes32(f, "USDC", vm.envBytes32("USDC_FEED"));
        string memory feeds = vm.serializeBytes32(f, "BTC", vm.envBytes32("BTC_FEED"));

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
        // A dry run never overwrites the deployment record. A broadcast writes it before its transactions are
        // mined, so run `pnpm verify:deployment` once they are (docs/DEPLOY.md).
        if (_broadcasting()) {
            vm.writeJson(json, path);
            console2.log("hub deployment written to", path);
        } else {
            console2.log("dry run: deployment not written to", path);
        }
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }
}
