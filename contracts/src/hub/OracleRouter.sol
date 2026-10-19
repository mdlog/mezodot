// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPriceSource} from "../oracle/IPriceSource.sol";

/// @title OracleRouter
/// @notice USD prices in WAD (1e18 = $1 per whole token) per asset key, from owner-registered vendor sources
///         (Pyth Core push/pull, Supra DORA pull). Risk-checked reads enforce per-leg freshness, a per-feed
///         confidence cap and a cross-vendor consistency check; `getPriceUnsafe` is for views and UIs.
/// @dev Each key has a primary leg and an optional secondary leg, each with its own maxAge (hourly push feeds
///      and 120 s pull feeds coexist). Strict reads use the freshest usable leg (fresh and confident; the
///      primary on a tie), so an hour-old push price never overrides a seconds-old pull proof. The other leg
///      cross-checks it within maxDivergenceBps when both are usable and were published within
///      CROSS_CHECK_WINDOW of each other, or when the other leg holds newer data that failed only its own age
///      or confidence check: an older price is never served against newer information that contradicts it.
///      Disagreement fails closed.
///      Price updates are tagged: each `bytes` element is `sourceTag (1 byte) ‖ vendor payload`.
contract OracleRouter is Ownable2Step {
    uint256 internal constant BPS = 10_000;
    /// Config guards for any feed; deployed values are far lower.
    uint32 public constant MAX_AGE_CAP = 3 hours;
    uint16 public constant MAX_CONF_CAP_BPS = 1_000;
    uint16 public constant MAX_DIVERGENCE_CAP_BPS = 2_000;
    /// Usable legs are cross-checked when their publish times are at most this far apart (seconds).
    uint256 public constant CROSS_CHECK_WINDOW = 60;

    struct Leg {
        /// Tag in `sources`; 0 = no leg.
        uint8 source;
        /// Maximum age in seconds.
        uint32 maxAge;
        /// Vendor feed id: Pyth price id, or a Supra pair index as bytes32.
        bytes32 id;
    }

    struct Feed {
        Leg primary;
        Leg secondary;
        /// Maximum confidence interval as basis points of the price (vendors without one report 0).
        uint16 maxConfBps;
        /// Maximum disagreement between fresh legs; 0 disables the cross-check.
        uint16 maxDivergenceBps;
    }

    enum Status {
        Ok,
        Unavailable,
        Diverged
    }

    mapping(uint8 tag => IPriceSource) public sources;
    mapping(bytes32 key => Feed) internal _feeds;

    event SourceSet(uint8 indexed tag, address source);
    event FeedSet(bytes32 indexed key, Feed feed);

    error UnknownFeed();
    error UnknownSource(uint8 tag);
    error InvalidConfig();
    error InvalidUpdate();
    error PriceUnavailable(bytes32 key);
    error PriceDiverged(bytes32 key);
    error InsufficientFee();
    error RefundFailed();

    constructor(address owner_) Ownable(owner_) {}

    // ---------------------------------------------------------------- admin

    /// @notice Registers (or replaces, or with address(0) removes) the source behind `tag`.
    function setSource(uint8 tag, IPriceSource source) external onlyOwner {
        if (tag == 0) revert InvalidConfig();
        sources[tag] = source;
        emit SourceSet(tag, address(source));
    }

    /// @param key keccak256 of the asset symbol, e.g. keccak256("MUSD").
    function setFeed(bytes32 key, Feed calldata f) external onlyOwner {
        _checkLeg(f.primary, false);
        _checkLeg(f.secondary, true);
        if (f.maxConfBps == 0 || f.maxConfBps > MAX_CONF_CAP_BPS) revert InvalidConfig();
        if (f.maxDivergenceBps > MAX_DIVERGENCE_CAP_BPS) revert InvalidConfig();
        _feeds[key] = f;
        emit FeedSet(key, f);
    }

    function feeds(bytes32 key) external view returns (Feed memory) {
        return _feeds[key];
    }

    // ---------------------------------------------------------------- updates (pull model)

    function updateFee(bytes[] calldata updates) public view returns (uint256 fee) {
        for (uint256 i = 0; i < updates.length; i++) {
            (IPriceSource source, bytes calldata payload) = _route(updates[i]);
            fee += source.updateFee(payload);
        }
    }

    /// @notice Verifies and stores tagged vendor updates, then refunds unused value to the caller.
    function updatePrices(bytes[] calldata updates) external payable returns (uint256 feePaid) {
        for (uint256 i = 0; i < updates.length; i++) {
            (IPriceSource source, bytes calldata payload) = _route(updates[i]);
            uint256 fee = source.updateFee(payload);
            feePaid += fee;
            if (feePaid > msg.value) revert InsufficientFee();
            // Forwarded even when the fee is zero (Pyth on Mezo testnet charges nothing).
            source.update{value: fee}(payload);
        }
        uint256 refund = msg.value - feePaid;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ---------------------------------------------------------------- reads

    /// @notice Fresh, confident and (when two legs are fresh) consistent price; reverts otherwise.
    function getPrice(bytes32 key) external view returns (uint256) {
        Feed storage f = _feeds[key];
        if (f.primary.source == 0) revert UnknownFeed();
        (Status status, uint256 price,) = _select(f);
        if (status == Status.Diverged) revert PriceDiverged(key);
        if (status != Status.Ok) revert PriceUnavailable(key);
        return price;
    }

    /// @notice Non-reverting `getPrice`: (false, 0) for unknown keys and unavailable or diverging prices.
    ///         Used for conservative collateral valuation.
    function tryGetPrice(bytes32 key) external view returns (bool ok, uint256 priceWad) {
        (ok, priceWad,) = getPriceInfo(key);
    }

    /// @notice `tryGetPrice` plus the time until which this price stays available: the expiry of the selected
    ///         (freshest usable) leg. The other leg may still serve after that, subject to the cross-check. Lets
    ///         clients attach a pull update only when a key would otherwise expire before their transaction lands.
    function getPriceInfo(bytes32 key) public view returns (bool ok, uint256 priceWad, uint256 validUntil) {
        Feed storage f = _feeds[key];
        if (f.primary.source == 0) return (false, 0, 0);
        Status status;
        (status, priceWad, validUntil) = _select(f);
        if (status != Status.Ok) return (false, 0, 0);
        ok = true;
    }

    /// @notice Newest stored value across both legs, without freshness checks (views and UIs only).
    /// @dev Never reverts: unknown keys and never-updated feeds return (0, 0).
    function getPriceUnsafe(bytes32 key) external view returns (uint256 priceWad, uint256 publishTime) {
        Feed storage f = _feeds[key];
        if (f.primary.source == 0) return (0, 0);
        (priceWad,, publishTime) = _latest(f.primary);
        if (f.secondary.source != 0) {
            (uint256 p2,, uint256 t2) = _latest(f.secondary);
            if (p2 != 0 && (priceWad == 0 || t2 > publishTime)) (priceWad, publishTime) = (p2, t2);
        }
        if (priceWad == 0) publishTime = 0;
    }

    // ---------------------------------------------------------------- internals

    function _select(Feed storage f) internal view returns (Status, uint256 price, uint256 validUntil) {
        (bool ok1, uint256 p1, uint256 t1) = _read(f.primary, f.maxConfBps);
        (bool ok2, uint256 p2, uint256 t2) = f.secondary.source == 0 ? (false, 0, 0) : _read(f.secondary, f.maxConfBps);
        if (!ok1 && !ok2) return (Status.Unavailable, 0, 0);
        bool useSecondary = ok2 && (!ok1 || t2 > t1);
        uint256 time;
        (price, time, validUntil) = useSecondary ? (p2, t2, t2 + f.secondary.maxAge) : (p1, t1, t1 + f.primary.maxAge);
        (bool otherOk, uint256 other, uint256 otherTime) = useSecondary ? (ok1, p1, t1) : (ok2, p2, t2);
        // A newer other leg is necessarily unusable here (it would have been selected), but its data still
        // contradicts an older price.
        bool crossCheck = other != 0 && (otherTime > time || (otherOk && time - otherTime <= CROSS_CHECK_WINDOW));
        if (crossCheck && f.maxDivergenceBps != 0) {
            uint256 lo = price < other ? price : other;
            if (_absDiff(price, other) * BPS > lo * f.maxDivergenceBps) return (Status.Diverged, 0, 0);
        }
        return (Status.Ok, price, validUntil);
    }

    function _read(Leg storage leg, uint16 maxConfBps) internal view returns (bool ok, uint256 price, uint256 time) {
        uint256 conf;
        (price, conf, time) = _latest(leg);
        if (price == 0 || time == 0) return (false, 0, 0);
        // Vendors may publish slightly ahead of the block (Supra accepts +15 s); count that as age 0.
        uint256 age = block.timestamp > time ? block.timestamp - time : 0;
        ok = age <= leg.maxAge && conf * BPS <= price * maxConfBps;
    }

    function _latest(Leg storage leg) internal view returns (uint256 price, uint256 conf, uint256 time) {
        IPriceSource source = sources[leg.source];
        if (address(source) == address(0)) return (0, 0, 0);
        // A misbehaving vendor contract must not block the other leg.
        try source.latest(leg.id) returns (uint256 p, uint256 c, uint256 t) {
            return (p, c, t);
        } catch {
            return (0, 0, 0);
        }
    }

    function _route(bytes calldata update) internal view returns (IPriceSource source, bytes calldata payload) {
        if (update.length < 2) revert InvalidUpdate();
        uint8 tag = uint8(update[0]);
        source = sources[tag];
        if (address(source) == address(0)) revert UnknownSource(tag);
        payload = update[1:];
    }

    function _checkLeg(Leg calldata leg, bool optional) internal view {
        if (leg.source == 0) {
            if (!optional) revert InvalidConfig();
            return;
        }
        if (address(sources[leg.source]) == address(0)) revert UnknownSource(leg.source);
        if (leg.maxAge == 0 || leg.maxAge > MAX_AGE_CAP) revert InvalidConfig();
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
