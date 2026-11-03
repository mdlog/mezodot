// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {OracleRouter} from "../src/hub/OracleRouter.sol";
import {PythSource} from "../src/oracle/PythSource.sol";
import {SkipSource, IAggregatorV3} from "../src/oracle/SkipSource.sol";
import {TigrisTwapSource} from "../src/oracle/TigrisTwapSource.sol";
import {ITigrisTwapPool} from "../src/interfaces/ITigrisPool.sol";
import {MockSkipFeed} from "./mocks/MockSkipFeed.sol";
import {MockTwapPool} from "./mocks/MockTwapPool.sol";

contract SkipSourceTest is Test {
    MockSkipFeed internal feed;
    SkipSource internal source;

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockSkipFeed(18);
        source = new SkipSource(IAggregatorV3(address(feed)), 18);
    }

    function test_latest_reportsThePriceInWadWithoutConfidence() public {
        feed.set(77_763e18, block.timestamp - 3);
        (uint256 price, uint256 conf, uint256 time) = source.latest(bytes32(0));
        assertEq(price, 77_763e18);
        assertEq(conf, 0);
        assertEq(time, block.timestamp - 3);
    }

    function test_latest_scalesFeedsBelowEighteenDecimals() public {
        MockSkipFeed eight = new MockSkipFeed(8);
        eight.set(77_763e8, block.timestamp);
        (uint256 price,,) = new SkipSource(IAggregatorV3(address(eight)), 8).latest(bytes32(0));
        assertEq(price, 77_763e18);
    }

    function test_latest_reportsNothingForANonPositiveAnswer() public {
        feed.set(-1, block.timestamp);
        (uint256 price,, uint256 time) = source.latest(bytes32(0));
        assertEq(price, 0);
        assertEq(time, 0);
    }

    function test_latest_doesNotRevertWhenTheFeedIsDown() public {
        feed.setBroken(true);
        (uint256 price,, uint256 time) = source.latest(bytes32(0));
        assertEq(price, 0);
        assertEq(time, 0);
    }

    function test_update_isRefusedBecauseTheFeedTakesNoProofs() public {
        assertEq(source.updateFee(hex"00"), 0);
        vm.expectRevert(SkipSource.NoPullUpdates.selector);
        source.update(hex"00");
    }
}

contract TigrisTwapSourceTest is Test {
    uint8 internal constant PYTH = 1;
    uint8 internal constant TWAP = 4;
    uint32 internal constant PUSH_AGE = 3_900;
    bytes32 internal constant K_MUSD = keccak256("MUSD");
    bytes32 internal constant K_MEZO = keccak256("MEZO");
    bytes32 internal constant PYTH_MUSD = bytes32(uint256(1));
    bytes32 internal constant PYTH_MEZO = bytes32(uint256(2));
    address internal constant MUSD = address(0x1189);
    address internal constant BTC = address(0xB7C);
    address internal constant MEZO = address(0x3E20);

    MockPyth internal pyth;
    MockSkipFeed internal skipFeed;
    SkipSource internal skipLeg;
    MockTwapPool internal btcPool;
    MockTwapPool internal mezoPool;
    TigrisTwapSource internal source;
    OracleRouter internal router;

    function setUp() public {
        vm.warp(1_800_000_000);
        pyth = new MockPyth(60, 0);
        skipFeed = new MockSkipFeed(18);
        skipLeg = new SkipSource(IAggregatorV3(address(skipFeed)), 18);
        // 1 BTC = 80,000 MUSD; 1 MEZO = 0.006 MUSD. Token order differs between the pools on purpose.
        btcPool = new MockTwapPool(MUSD, BTC, 80_000_000e18, 1_000e18);
        mezoPool = new MockTwapPool(MEZO, MUSD, 1_000_000e18, 6_000e18);
        source = new TigrisTwapSource(
            TigrisTwapSource.Config({
                anchor: new PythSource(pyth),
                btcUsd: skipLeg,
                btcMaxAge: 120,
                anchorMaxAge: PUSH_AGE,
                btcPool: ITigrisTwapPool(address(btcPool)),
                mezoPool: ITigrisTwapPool(address(mezoPool)),
                musd: MUSD,
                anchorMusd: PYTH_MUSD,
                anchorMezo: PYTH_MEZO,
                musdBandBps: 300,
                mezoBandBps: 1_500
            })
        );
        router = new OracleRouter(address(this));
        router.setSource(PYTH, new PythSource(pyth));
        router.setSource(TWAP, source);
        router.setFeed(K_MUSD, _feed(PYTH_MUSD, source.MUSD_ID()));
        router.setFeed(K_MEZO, _feed(PYTH_MEZO, source.MEZO_ID()));

        // Two observation periods of history at those prices.
        _elapse(1_801);
        _elapse(1_801);
        _pushPyth(PYTH_MUSD, 1e8, block.timestamp);
        _pushPyth(PYTH_MEZO, 600_000, block.timestamp);
        skipFeed.set(80_000e18, block.timestamp);
    }

    function _feed(bytes32 pythId, bytes32 twapId) internal pure returns (OracleRouter.Feed memory) {
        return OracleRouter.Feed({
            primary: OracleRouter.Leg({source: PYTH, maxAge: PUSH_AGE, id: pythId}),
            secondary: OracleRouter.Leg({source: TWAP, maxAge: PUSH_AGE, id: twapId}),
            maxConfBps: 500,
            maxDivergenceBps: 2_000
        });
    }

    /// Moves time and stores an observation in both pools at unchanged reserves.
    function _elapse(uint256 secs) internal {
        vm.warp(block.timestamp + secs);
        (uint256 a, uint256 b,) = btcPool.getReserves();
        btcPool.setReserves(a, b);
        (a, b,) = mezoPool.getReserves();
        mezoPool.setReserves(a, b);
    }

    function _pushPyth(bytes32 id, int64 price, uint256 time) internal {
        bytes[] memory updates = new bytes[](1);
        updates[0] = pyth.createPriceFeedUpdateData(id, price, 0, -8, price, 0, uint64(time));
        pyth.updatePriceFeeds(updates);
    }

    /// Lets Mezo's push go stale while the BTC feed stays live.
    function _stalePyth() internal {
        _elapse(PUSH_AGE + 1);
        skipFeed.set(80_000e18, block.timestamp);
    }

    // ------------------------------------------------------------------ price

    function test_musd_isBtcUsdOverTheMusdPerBtcTwap() public view {
        (uint256 price,,) = source.latest(source.MUSD_ID());
        assertApproxEqRel(price, 1e18, 1e12);
    }

    function test_musd_followsThePoolOverTheWindow() public {
        // BTC buys 1% fewer MUSD on the pool while BTC/USD holds: MUSD is worth 1% more.
        btcPool.setReserves(79_200_000e18, 1_000e18);
        _elapse(1_801);
        _elapse(1_801);
        skipFeed.set(80_000e18, block.timestamp);
        (uint256 price,,) = source.latest(source.MUSD_ID());
        assertApproxEqRel(price, 1.0101e18, 1e15);
    }

    function test_mezo_isTheMusdTwapTimesTheMusdPrice() public view {
        (uint256 price,,) = source.latest(source.MEZO_ID());
        assertApproxEqRel(price, 0.006e18, 1e12);
    }

    function test_unknownId_reportsNothing() public view {
        (uint256 price,, uint256 time) = source.latest(keccak256("ETH"));
        assertEq(price, 0);
        assertEq(time, 0);
    }

    // ------------------------------------------------------------------ the push stays first

    function test_freshPush_keepsThisLegJustOlderThanThePush() public view {
        (,, uint256 pythTime) = PythSource(address(router.sources(PYTH))).latest(PYTH_MUSD);
        (,, uint256 time) = source.latest(source.MUSD_ID());
        assertEq(time, pythTime - 1);
    }

    function test_freshPush_isWhatTheRouterServes() public {
        // Mezo's push says 0.99; the pool says 1.00: the push is served, and the legs agree within the limit.
        vm.warp(block.timestamp + 1);
        _pushPyth(PYTH_MUSD, 0.99e8, block.timestamp);
        assertEq(router.getPrice(K_MUSD), 0.99e18);
    }

    function test_freshPush_isNotBlockedByAPoolOutsideTheBand() public {
        btcPool.setReserves(40_000_000e18, 1_000e18); // the pool halves MUSD's dollar price over the window
        _elapse(1_801);
        _elapse(1_801);
        skipFeed.set(80_000e18, block.timestamp);
        _pushPyth(PYTH_MUSD, 1e8, block.timestamp);
        assertEq(router.getPrice(K_MUSD), 1e18);
    }

    // ------------------------------------------------------------------ fallback

    function test_stalePush_reportsTheCurrentTime() public {
        _stalePyth();
        (,, uint256 time) = source.latest(source.MUSD_ID());
        assertEq(time, block.timestamp);
    }

    function test_stalePush_theRouterServesTheFallback() public {
        _stalePyth();
        assertApproxEqRel(router.getPrice(K_MUSD), 1e18, 1e12);
        assertApproxEqRel(router.getPrice(K_MEZO), 0.006e18, 1e12);
    }

    function test_stalePush_outsideTheBandFailsAsItDoesWithoutThisLeg() public {
        vm.warp(block.timestamp + 10);
        btcPool.setReserves(77_000_000e18, 1_000e18); // implies about $1.039, past the 3% band
        _elapse(1_801);
        _elapse(1_801);
        _stalePyth();
        (uint256 price,, uint256 time) = source.latest(source.MUSD_ID());
        assertEq(price, 0);
        assertEq(time, 0);
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, K_MUSD));
        router.getPrice(K_MUSD);
    }

    function test_mezo_outsideItsWiderBandReportsNothing() public {
        mezoPool.setReserves(1_000_000e18, 1_000_000e18); // the testnet pool's real state: 1 MEZO for about 1 MUSD
        _elapse(1_801);
        _elapse(1_801);
        (uint256 price,,) = source.latest(source.MEZO_ID());
        assertEq(price, 0);
    }

    function test_staleBtcFeed_reportsNothing() public {
        vm.warp(block.timestamp + 121);
        (uint256 price,,) = source.latest(source.MUSD_ID());
        assertEq(price, 0);
    }

    function test_brokenBtcFeed_reportsNothing() public {
        skipFeed.setBroken(true);
        (uint256 price,,) = source.latest(source.MUSD_ID());
        assertEq(price, 0);
    }

    function test_neverPublishedAnchor_reportsNothing() public {
        MockPyth empty = new MockPyth(60, 0);
        TigrisTwapSource noAnchor = new TigrisTwapSource(
            TigrisTwapSource.Config({
                anchor: new PythSource(empty),
                btcUsd: skipLeg,
                btcMaxAge: 120,
                anchorMaxAge: PUSH_AGE,
                btcPool: ITigrisTwapPool(address(btcPool)),
                mezoPool: ITigrisTwapPool(address(mezoPool)),
                musd: MUSD,
                anchorMusd: PYTH_MUSD,
                anchorMezo: PYTH_MEZO,
                musdBandBps: 300,
                mezoBandBps: 1_500
            })
        );
        (uint256 price,,) = noAnchor.latest(noAnchor.MUSD_ID());
        assertEq(price, 0);
    }

    function test_poolWithoutHistory_reportsNothing() public {
        MockTwapPool fresh = new MockTwapPool(MUSD, BTC, 80_000_000e18, 1_000e18);
        TigrisTwapSource noHistory = new TigrisTwapSource(
            TigrisTwapSource.Config({
                anchor: new PythSource(pyth),
                btcUsd: skipLeg,
                btcMaxAge: 120,
                anchorMaxAge: PUSH_AGE,
                btcPool: ITigrisTwapPool(address(fresh)),
                mezoPool: ITigrisTwapPool(address(mezoPool)),
                musd: MUSD,
                anchorMusd: PYTH_MUSD,
                anchorMezo: PYTH_MEZO,
                musdBandBps: 300,
                mezoBandBps: 1_500
            })
        );
        (uint256 price,,) = noHistory.latest(noHistory.MUSD_ID());
        assertEq(price, 0);
    }

    // ------------------------------------------------------------------ manipulation

    function test_aSpotMove_doesNotMoveTheWindowedPrice() public {
        _elapse(1_801);
        skipFeed.set(80_000e18, block.timestamp);
        (uint256 before,,) = source.latest(source.MUSD_ID());
        btcPool.setReserves(88_000_000e18, 1_000e18); // a 10% push on the pool, moments ago
        vm.warp(block.timestamp + 5);
        skipFeed.set(80_000e18, block.timestamp);
        (uint256 price,,) = source.latest(source.MUSD_ID());
        assertApproxEqRel(price, before, 1e15);
    }

    function test_aSpotMove_widensConfidenceSoTheRouterRefusesTheLeg() public {
        _stalePyth();
        btcPool.setReserves(88_000_000e18, 1_000e18);
        vm.warp(block.timestamp + 5);
        skipFeed.set(80_000e18, block.timestamp);
        (uint256 price, uint256 conf,) = source.latest(source.MUSD_ID());
        assertGt(conf * 10_000, price * 500);
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, K_MUSD));
        router.getPrice(K_MUSD);
    }

    function test_update_isRefused() public {
        assertEq(source.updateFee(hex"00"), 0);
        vm.expectRevert(TigrisTwapSource.NoPullUpdates.selector);
        source.update(hex"00");
    }
}
