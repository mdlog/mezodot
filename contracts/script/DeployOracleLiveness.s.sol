// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {OracleRouter} from "../src/hub/OracleRouter.sol";
import {SkipSource, IAggregatorV3} from "../src/oracle/SkipSource.sol";
import {TigrisTwapSource} from "../src/oracle/TigrisTwapSource.sol";
import {ITigrisPoolFactory, ITigrisTwapPool} from "../src/interfaces/ITigrisPool.sol";

/// @notice Gives the live router keyless feeds from Mezo's own infrastructure, and records them in
///         packages/sdk/src/deployments/<NETWORK>.json:
///         - BTC: Mezo's Skip feed replaces the Pyth pull leg as primary; Supra stays as the cross-checked second leg.
///         - MUSD, MEZO: TigrisTwapSource becomes the second leg behind Mezo's Pyth push (liveness only, see the
///           contract). A pool priced outside its band leaves that key as it was.
///         Broadcast by the router's owner.
/// Env: NETWORK; optional SKIP_FEED, BTC_MAX_AGE (120), MUSD_MAX_AGE and MEZO_MAX_AGE (3900), MUSD_BAND_BPS (300),
///      MEZO_BAND_BPS (1500).
contract DeployOracleLiveness is Script {
    using stdJson for string;

    uint8 internal constant PYTH_TAG = 1;
    uint8 internal constant SKIP_TAG = 3;
    uint8 internal constant TWAP_TAG = 4;
    /// Above each band, so the cross-check can never turn a price inside the band into a failure.
    uint16 internal constant MUSD_DIVERGENCE_BPS = 500;
    uint16 internal constant MEZO_DIVERGENCE_BPS = 2_000;

    function run() external returns (SkipSource skipSource, TigrisTwapSource twapSource) {
        string memory path =
            string.concat(vm.projectRoot(), "/../packages/sdk/src/deployments/", vm.envString("NETWORK"), ".json");
        string memory json = vm.readFile(path);
        OracleRouter router = OracleRouter(json.readAddress(".contracts.oracleRouter"));
        ITigrisPoolFactory factory = ITigrisPoolFactory(json.readAddress(".contracts.tigrisFactory"));
        address musd = json.readAddress(".tokens.MUSD");
        address mezo = json.readAddress(".tokens.MEZO");
        address btcPool = json.readAddress(".contracts.tigrisPool");
        address mezoPool = factory.getPool(mezo, musd, false);
        require(mezoPool != address(0), "DeployOracleLiveness: no Tigris MEZO/MUSD pool");

        address feed = vm.envOr("SKIP_FEED", address(0x7b7c000000000000000000000000000000000015));
        uint32 btcMaxAge = uint32(vm.envOr("BTC_MAX_AGE", uint256(120)));
        uint32 musdMaxAge = uint32(vm.envOr("MUSD_MAX_AGE", uint256(3_900)));
        uint32 mezoMaxAge = uint32(vm.envOr("MEZO_MAX_AGE", uint256(3_900)));
        require(musdMaxAge == mezoMaxAge, "DeployOracleLiveness: one anchor max age for both pushes");

        vm.startBroadcast();
        skipSource = new SkipSource(IAggregatorV3(feed), 18);
        twapSource = new TigrisTwapSource(
            TigrisTwapSource.Config({
                anchor: router.sources(PYTH_TAG),
                btcUsd: skipSource,
                btcMaxAge: btcMaxAge,
                anchorMaxAge: musdMaxAge,
                btcPool: ITigrisTwapPool(btcPool),
                mezoPool: ITigrisTwapPool(mezoPool),
                musd: musd,
                anchorMusd: json.readBytes32(".priceFeeds.MUSD"),
                anchorMezo: json.readBytes32(".priceFeeds.MEZO"),
                musdBandBps: uint16(vm.envOr("MUSD_BAND_BPS", uint256(300))),
                mezoBandBps: uint16(vm.envOr("MEZO_BAND_BPS", uint256(1_500)))
            })
        );
        router.setSource(SKIP_TAG, skipSource);
        router.setSource(TWAP_TAG, twapSource);

        bytes32 btcKey = keccak256("BTC");
        OracleRouter.Feed memory btcFeed = router.feeds(btcKey);
        btcFeed.primary = OracleRouter.Leg({source: SKIP_TAG, maxAge: btcMaxAge, id: bytes32(0)});
        router.setFeed(btcKey, btcFeed);
        _setFallback(router, keccak256("MUSD"), twapSource.MUSD_ID(), musdMaxAge, MUSD_DIVERGENCE_BPS);
        _setFallback(router, keccak256("MEZO"), twapSource.MEZO_ID(), mezoMaxAge, MEZO_DIVERGENCE_BPS);
        vm.stopBroadcast();

        string[] memory keys = vm.parseJsonKeys(json, ".contracts");
        string memory obj = "contracts";
        for (uint256 i = 0; i < keys.length; i++) {
            vm.serializeAddress(obj, keys[i], json.readAddress(string.concat(".contracts.", keys[i])));
        }
        vm.serializeAddress(obj, "skipSource", address(skipSource));
        string memory contracts = vm.serializeAddress(obj, "twapSource", address(twapSource));
        // A dry run never overwrites the deployment record (see DeployHub).
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            vm.writeJson(contracts, path, ".contracts");
        } else {
            console2.log("dry run: deployment not written to", path);
        }
        console2.log("SkipSource", address(skipSource));
        console2.log("TigrisTwapSource", address(twapSource));
    }

    function _setFallback(OracleRouter router, bytes32 key, bytes32 id, uint32 maxAge, uint16 divergenceBps) internal {
        OracleRouter.Feed memory feed = router.feeds(key);
        feed.secondary = OracleRouter.Leg({source: TWAP_TAG, maxAge: maxAge, id: id});
        feed.maxDivergenceBps = divergenceBps;
        router.setFeed(key, feed);
    }
}
