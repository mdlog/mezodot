// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {OracleRouter} from "../src/hub/OracleRouter.sol";
import {IPriceSource} from "../src/oracle/IPriceSource.sol";
import {PythSource} from "../src/oracle/PythSource.sol";
import {SupraSource} from "../src/oracle/SupraSource.sol";
import {MockSupraPull} from "./mocks/MockSupraPull.sol";

contract RevertingSource is IPriceSource {
    function updateFee(bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function update(bytes calldata) external payable {}

    function latest(bytes32) external pure returns (uint256, uint256, uint256) {
        revert("boom");
    }
}

contract OracleRouterTest is Test {
    uint8 internal constant PYTH = 1;
    uint8 internal constant SUPRA = 2;
    uint8 internal constant BAD = 3;
    bytes32 internal constant MUSD = keccak256("MUSD");
    bytes32 internal constant MEZO = keccak256("MEZO");
    bytes32 internal constant ETH = keccak256("ETH");
    bytes32 internal constant MUSD_ID = bytes32(uint256(0x11));
    bytes32 internal constant MEZO_ID = bytes32(uint256(0x3E20));
    bytes32 internal constant ETH_ID = bytes32(uint256(0xE7));
    bytes32 internal constant SUPRA_ETH = bytes32(uint256(19));

    MockPyth internal pyth;
    MockSupraPull internal supraPull;
    OracleRouter internal router;

    function setUp() public {
        vm.warp(1_792_263_654);
        pyth = new MockPyth(60, 1 wei);
        supraPull = new MockSupraPull();
        router = new OracleRouter(address(this));
        router.setSource(PYTH, new PythSource(pyth));
        router.setSource(SUPRA, new SupraSource(supraPull));
        router.setSource(BAD, new RevertingSource());
        // MUSD / MEZO: Pyth push feeds (Mezo's pusher, ~1 h heartbeat) with a 5% confidence cap.
        router.setFeed(MUSD, _feed(_leg(PYTH, 3_900, MUSD_ID), _none(), 500, 0));
        router.setFeed(MEZO, _feed(_leg(PYTH, 3_900, MEZO_ID), _none(), 500, 0));
        // ETH: Pyth (fresh only when someone pushes it) then keyless Supra pull, 120 s each, 1.5% cross-check.
        router.setFeed(ETH, _feed(_leg(PYTH, 120, ETH_ID), _leg(SUPRA, 120, SUPRA_ETH), 200, 150));
    }

    // ------------------------------------------------------------------ helpers

    function _leg(uint8 s, uint32 maxAge, bytes32 id) internal pure returns (OracleRouter.Leg memory) {
        return OracleRouter.Leg({source: s, maxAge: maxAge, id: id});
    }

    function _none() internal pure returns (OracleRouter.Leg memory) {
        return OracleRouter.Leg({source: 0, maxAge: 0, id: bytes32(0)});
    }

    function _feed(OracleRouter.Leg memory a, OracleRouter.Leg memory b, uint16 confBps, uint16 divBps)
        internal
        pure
        returns (OracleRouter.Feed memory)
    {
        return OracleRouter.Feed({primary: a, secondary: b, maxConfBps: confBps, maxDivergenceBps: divBps});
    }

    function _pythUpdate(bytes32 id, int64 price, uint64 conf, int32 expo, uint256 publishTime)
        internal
        view
        returns (bytes memory)
    {
        bytes memory raw = pyth.createPriceFeedUpdateData(id, price, conf, expo, price, conf, uint64(publishTime));
        return abi.encodePacked(PYTH, raw);
    }

    function _pythUpdate(bytes32 id, int64 price, uint64 conf, uint256 publishTime)
        internal
        view
        returns (bytes memory)
    {
        return _pythUpdate(id, price, conf, -8, publishTime);
    }

    function _supraUpdate(uint256 price8, uint256 publishTime) internal view returns (bytes memory) {
        return abi.encodePacked(SUPRA, supraPull.encode(19, price8, publishTime * 1000, 8));
    }

    function _push(bytes memory u) internal {
        bytes[] memory updates = new bytes[](1);
        updates[0] = u;
        router.updatePrices{value: router.updateFee(updates)}(updates);
    }

    // ------------------------------------------------------------------ normalisation (Pyth leg)

    function test_normalisesNegativeExponentToWad() public {
        _push(_pythUpdate(ETH_ID, 3_200_00000000, 1_00000000, block.timestamp));
        assertEq(router.getPrice(ETH), 3_200e18);
    }

    function test_normalisesSmallPrices() public {
        _push(_pythUpdate(MEZO_ID, 794_000, 1_000, block.timestamp)); // MEZO ≈ $0.00794
        assertEq(router.getPrice(MEZO), 0.00794e18);
    }

    function test_normalisesPositiveExponent() public {
        _push(_pythUpdate(ETH_ID, 32, 0, 2, block.timestamp));
        assertEq(router.getPrice(ETH), 3_200e18);
    }

    function test_nonPositivePriceIsUnavailable() public {
        _push(_pythUpdate(MUSD_ID, 0, 0, block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, MUSD));
        router.getPrice(MUSD);
    }

    // ------------------------------------------------------------------ per-key maxAge

    function test_pushFeedAcceptsHourlyHeartbeatButNotBeyondMaxAge() public {
        _push(_pythUpdate(MUSD_ID, 98_883_775, 10_000, block.timestamp - 3_668)); // longest gap since cutover
        assertEq(router.getPrice(MUSD), 0.98883775e18);
        skip(233); // age 3,901 s
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, MUSD));
        router.getPrice(MUSD);
        (bool ok,) = router.tryGetPrice(MUSD);
        assertFalse(ok);
        (uint256 p, uint256 t) = router.getPriceUnsafe(MUSD);
        assertEq(p, 0.98883775e18);
        assertEq(t, block.timestamp - 3_901);
    }

    function test_pullLegStaleAfterItsOwnMaxAge() public {
        _push(_pythUpdate(ETH_ID, 3_200e8, 0, block.timestamp));
        skip(121);
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, ETH));
        router.getPrice(ETH);
        (uint256 p, uint256 t) = router.getPriceUnsafe(ETH); // views still see the last value
        assertEq(p, 3_200e18);
        assertEq(t, block.timestamp - 121);
    }

    // ------------------------------------------------------------------ confidence (per feed)

    /// Audit (oracle-confidence-calibration): MUSD's real conf/price has a median of 1.22% and a p99 of 2.87%,
    /// and the stored testnet value is 1.04%. A 2% global gate froze MUSD for hours; the per-feed cap does not.
    function test_realisticMusdConfidencePassesPerFeedCap() public {
        uint256 t0 = block.timestamp;
        _push(_pythUpdate(MUSD_ID, 98_883_775, 1_028_391, t0)); // 1.04%
        assertEq(router.getPrice(MUSD), 0.98883775e18);
        skip(1);
        _push(_pythUpdate(MUSD_ID, 99_190_000, 4_760_000, t0 + 1)); // 4.8%: worst run observed
        assertEq(router.getPrice(MUSD), 0.9919e18);
    }

    function test_confidenceAboveFeedCapIsUnavailable() public {
        _push(_pythUpdate(MUSD_ID, 99_190_000, 10_514_000, block.timestamp)); // 10.6%: the max observed
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, MUSD));
        router.getPrice(MUSD);
        (bool ok, uint256 p) = router.tryGetPrice(MUSD);
        assertFalse(ok);
        assertEq(p, 0);
    }

    function test_unconfidentPrimaryFallsBack() public {
        _push(_pythUpdate(ETH_ID, 241_000_000_000, 7_300_000_000, block.timestamp)); // conf 3% > 2%
        _push(_supraUpdate(241_298_000_000, block.timestamp));
        assertEq(router.getPrice(ETH), 2_412.98e18);
    }

    // ------------------------------------------------------------------ primary / secondary

    function test_ethFallsBackToSupraWhenPythFeedWasNeverPushed() public {
        _push(_supraUpdate(241_298_000_000, block.timestamp - 5));
        assertEq(router.getPrice(ETH), 2_412.98e18);
    }

    function test_primaryPreferredWhenFresh() public {
        _push(_pythUpdate(ETH_ID, 241_000_000_000, 100_000_000, block.timestamp));
        _push(_supraUpdate(241_298_000_000, block.timestamp));
        assertEq(router.getPrice(ETH), 2_410e18); // within 1.5%: primary wins
    }

    function test_divergingLegsRevertStrictAndFailTry() public {
        _push(_pythUpdate(ETH_ID, 241_000_000_000, 100_000_000, block.timestamp));
        _push(_supraUpdate(248_300_000_000, block.timestamp - 10)); // +3.0%
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceDiverged.selector, ETH));
        router.getPrice(ETH);
        (bool ok,) = router.tryGetPrice(ETH);
        assertFalse(ok);
        (ok,,) = router.getPriceInfo(ETH);
        assertFalse(ok);
    }

    function test_noCrossCheckWhenPublishTimesFarApart() public {
        _push(_pythUpdate(ETH_ID, 241_000_000_000, 100_000_000, block.timestamp - 100));
        _push(_supraUpdate(248_300_000_000, block.timestamp)); // 100 s apart > 60 s window
        assertEq(router.getPrice(ETH), 2_410e18);
    }

    function test_revertingSourceDoesNotBlockOtherLeg() public {
        router.setFeed(ETH, _feed(_leg(BAD, 120, ETH_ID), _leg(SUPRA, 120, SUPRA_ETH), 200, 150));
        _push(_supraUpdate(241_298_000_000, block.timestamp));
        assertEq(router.getPrice(ETH), 2_412.98e18);
    }

    function test_neverUpdatedFeedIsZeroInViewsAndUnavailable() public {
        (uint256 p, uint256 t) = router.getPriceUnsafe(ETH);
        assertEq(p, 0);
        assertEq(t, 0);
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, ETH));
        router.getPrice(ETH);
    }

    function test_unknownKey() public {
        bytes32 nope = keccak256("NOPE");
        vm.expectRevert(OracleRouter.UnknownFeed.selector);
        router.getPrice(nope);
        (bool ok, uint256 p) = router.tryGetPrice(nope);
        assertFalse(ok);
        assertEq(p, 0);
        // Views never revert, so a misconfigured key cannot break position views.
        (uint256 up, uint256 ut) = router.getPriceUnsafe(nope);
        assertEq(up, 0);
        assertEq(ut, 0);
        (bool iok, uint256 ip, uint256 until) = router.getPriceInfo(nope);
        assertFalse(iok);
        assertEq(ip, 0);
        assertEq(until, 0);
    }

    // ------------------------------------------------------------------ getPriceInfo (clients decide on pull updates)

    function test_priceInfoReportsLatestExpiryAcrossUsableLegs() public {
        _push(_pythUpdate(ETH_ID, 241_000_000_000, 100_000_000, block.timestamp - 100)); // valid until now + 20
        _push(_supraUpdate(241_298_000_000, block.timestamp - 30)); // valid until now + 90
        (bool ok, uint256 price, uint256 until) = router.getPriceInfo(ETH);
        assertTrue(ok);
        assertEq(price, 2_410e18); // primary still selected
        assertEq(until, block.timestamp + 90);

        skip(21); // primary expired: same answer as getPrice, now from Supra
        (ok, price, until) = router.getPriceInfo(ETH);
        assertTrue(ok);
        assertEq(price, 2_412.98e18);
        assertEq(until, block.timestamp + 69);
        assertEq(router.getPrice(ETH), price);

        skip(70);
        (ok, price, until) = router.getPriceInfo(ETH);
        assertFalse(ok);
        assertEq(price, 0);
        assertEq(until, 0);
    }

    // ------------------------------------------------------------------ Supra specifics

    function test_supraFutureTimestampWithinAllowanceCountsAsFresh() public {
        _push(_supraUpdate(241_298_000_000, block.timestamp + 3)); // Supra accepts up to +15 s
        assertEq(router.getPrice(ETH), 2_412.98e18);
    }

    function test_supraOlderProofDoesNotOverwriteNewer() public {
        _push(_supraUpdate(241_298_000_000, block.timestamp));
        _push(_supraUpdate(200_000_000_000, block.timestamp - 30));
        assertEq(router.getPrice(ETH), 2_412.98e18);
    }

    function test_supraStaleProofIsStoredButNotUsable() public {
        _push(_supraUpdate(241_298_000_000, block.timestamp - 121)); // Supra itself has no max age
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.PriceUnavailable.selector, ETH));
        router.getPrice(ETH);
    }

    function test_supraNormalisesEighteenDecimals() public {
        bytes memory proof = supraPull.encode(19, 2_412.98e18, block.timestamp * 1000, 18);
        _push(abi.encodePacked(SUPRA, proof));
        assertEq(router.getPrice(ETH), 2_412.98e18);
    }

    function test_supraRejectsValueAndInvalidProof() public {
        SupraSource s = SupraSource(address(router.sources(SUPRA)));
        bytes memory proof = supraPull.encode(19, 1, block.timestamp * 1000, 8);
        vm.expectRevert(SupraSource.FeeNotAccepted.selector);
        s.update{value: 1}(proof);
        supraPull.setRejectAll(true);
        bytes[] memory updates = new bytes[](1);
        updates[0] = _supraUpdate(241_298_000_000, block.timestamp);
        vm.expectRevert(MockSupraPull.DataNotVerified.selector);
        router.updatePrices(updates);
    }

    // ------------------------------------------------------------------ tagged updates and fees

    function test_updateRoutingFeesAndRefund() public {
        address payer = makeAddr("payer");
        vm.deal(payer, 1 ether);
        bytes[] memory updates = new bytes[](2);
        updates[0] = _pythUpdate(MUSD_ID, 1e8, 0, block.timestamp);
        updates[1] = _supraUpdate(241_298_000_000, block.timestamp);
        assertEq(router.updateFee(updates), 1 wei); // MockPyth 1 wei, Supra 0
        vm.prank(payer);
        assertEq(router.updatePrices{value: 1 ether}(updates), 1 wei);
        assertEq(payer.balance, 1 ether - 1 wei);
        assertEq(router.getPrice(MUSD), 1e18);
        assertEq(router.getPrice(ETH), 2_412.98e18);
    }

    /// Final review M4: a zero-fee Pyth deployment (Mezo testnet 0x933a) must still receive the updates.
    function test_zeroFeeUpdatesArePushed() public {
        MockPyth freePyth = new MockPyth(60, 0);
        OracleRouter r = new OracleRouter(address(this));
        r.setSource(PYTH, new PythSource(freePyth));
        r.setFeed(ETH, _feed(_leg(PYTH, 120, ETH_ID), _none(), 200, 0));
        bytes[] memory updates = new bytes[](1);
        updates[0] = abi.encodePacked(
            PYTH, freePyth.createPriceFeedUpdateData(ETH_ID, 3_200e8, 0, -8, 3_200e8, 0, uint64(block.timestamp))
        );
        assertEq(r.updatePrices(updates), 0);
        assertEq(r.getPrice(ETH), 3_200e18);
    }

    function test_emptyUpdateIsFree() public {
        bytes[] memory none = new bytes[](0);
        assertEq(router.updateFee(none), 0);
        assertEq(router.updatePrices(none), 0);
    }

    function test_insufficientFeeUnknownTagAndShortUpdateRevert() public {
        bytes[] memory updates = new bytes[](1);
        updates[0] = _pythUpdate(MUSD_ID, 1e8, 0, block.timestamp);
        vm.expectRevert(OracleRouter.InsufficientFee.selector);
        router.updatePrices(updates);

        updates[0] = abi.encodePacked(uint8(9), hex"00");
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.UnknownSource.selector, uint8(9)));
        router.updatePrices(updates);

        updates[0] = abi.encodePacked(PYTH);
        vm.expectRevert(OracleRouter.InvalidUpdate.selector);
        router.updatePrices(updates);
    }

    // ------------------------------------------------------------------ config guards

    function test_configGuards() public {
        vm.expectRevert(OracleRouter.InvalidConfig.selector);
        router.setFeed(MUSD, _feed(_leg(PYTH, 0, MUSD_ID), _none(), 200, 0)); // zero maxAge
        vm.expectRevert(OracleRouter.InvalidConfig.selector);
        router.setFeed(MUSD, _feed(_leg(PYTH, 3 hours + 1, MUSD_ID), _none(), 200, 0)); // above cap
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.UnknownSource.selector, uint8(7)));
        router.setFeed(MUSD, _feed(_leg(7, 60, MUSD_ID), _none(), 200, 0)); // unregistered source
        vm.expectRevert(OracleRouter.InvalidConfig.selector);
        router.setFeed(MUSD, _feed(_leg(0, 60, MUSD_ID), _none(), 200, 0)); // no primary
        vm.expectRevert(OracleRouter.InvalidConfig.selector);
        router.setFeed(MUSD, _feed(_leg(PYTH, 60, MUSD_ID), _none(), 0, 0)); // zero confidence cap
        vm.expectRevert(OracleRouter.InvalidConfig.selector);
        router.setFeed(MUSD, _feed(_leg(PYTH, 60, MUSD_ID), _none(), 1_001, 0)); // confidence cap > 10%
        vm.expectRevert(OracleRouter.InvalidConfig.selector);
        router.setFeed(ETH, _feed(_leg(PYTH, 60, ETH_ID), _leg(SUPRA, 60, SUPRA_ETH), 200, 2_001)); // divergence
        RevertingSource extra = new RevertingSource();
        vm.expectRevert(OracleRouter.InvalidConfig.selector);
        router.setSource(0, extra); // tag 0 means "no leg"
    }

    function test_onlyOwnerConfigures() public {
        address stranger = makeAddr("stranger");
        OracleRouter.Feed memory f = _feed(_leg(PYTH, 60, MUSD_ID), _none(), 200, 0);
        vm.startPrank(stranger);
        vm.expectRevert();
        router.setFeed(MUSD, f);
        vm.expectRevert();
        router.setSource(PYTH, IPriceSource(address(0)));
        vm.stopPrank();
    }

    function test_feedsViewReturnsConfig() public view {
        OracleRouter.Feed memory f = router.feeds(ETH);
        assertEq(f.primary.source, PYTH);
        assertEq(f.primary.maxAge, 120);
        assertEq(f.primary.id, ETH_ID);
        assertEq(f.secondary.source, SUPRA);
        assertEq(f.secondary.id, SUPRA_ETH);
        assertEq(f.maxConfBps, 200);
        assertEq(f.maxDivergenceBps, 150);
    }

    receive() external payable {}
}
