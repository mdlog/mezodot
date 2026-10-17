// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title OracleRouter
/// @notice Pyth-backed USD prices normalised to WAD (1e18 = $1 per whole token).
///         Risk-checked reads enforce freshness and a confidence bound; `getPriceUnsafe` is for views/UI.
contract OracleRouter is Ownable2Step {
    uint256 internal constant BPS = 10_000;

    IPyth public immutable pyth;
    /// @notice Maximum price age in seconds accepted by `getPrice`.
    uint256 public immutable maxAge;
    /// @notice Maximum confidence interval as basis points of the price.
    uint256 public immutable maxConfBps;

    mapping(bytes32 key => bytes32 priceId) public feeds;

    event FeedSet(bytes32 indexed key, bytes32 priceId);

    error UnknownFeed();
    error InvalidPrice();
    error PriceUncertain();
    error InsufficientFee();
    error RefundFailed();

    constructor(IPyth pyth_, uint256 maxAge_, uint256 maxConfBps_, address owner_) Ownable(owner_) {
        pyth = pyth_;
        maxAge = maxAge_;
        maxConfBps = maxConfBps_;
    }

    /// @param key keccak256 of the asset symbol, e.g. keccak256("MUSD").
    function setFeed(bytes32 key, bytes32 priceId) external onlyOwner {
        feeds[key] = priceId;
        emit FeedSet(key, priceId);
    }

    function updateFee(bytes[] calldata updates) public view returns (uint256) {
        return updates.length == 0 ? 0 : pyth.getUpdateFee(updates);
    }

    /// @notice Pushes Pyth price updates (pull model) and refunds any excess value to the caller.
    function updatePrices(bytes[] calldata updates) external payable returns (uint256 feePaid) {
        feePaid = updateFee(updates);
        if (msg.value < feePaid) revert InsufficientFee();
        // Forward even when the fee is zero: some Pyth deployments charge nothing.
        if (updates.length > 0) pyth.updatePriceFeeds{value: feePaid}(updates);
        uint256 refund = msg.value - feePaid;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Fresh, high-confidence price; reverts otherwise.
    function getPrice(bytes32 key) external view returns (uint256) {
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(_id(key), maxAge);
        if (p.price <= 0) revert InvalidPrice();
        if (!_confident(p)) revert PriceUncertain();
        return _toWad(p.price, p.expo);
    }

    /// @notice Non-reverting `getPrice`: (false, 0) when the key is unknown or the price is missing,
    ///         stale, non-positive or too uncertain. Used for conservative collateral valuation.
    function tryGetPrice(bytes32 key) external view returns (bool ok, uint256 priceWad) {
        bytes32 id = feeds[key];
        if (id == bytes32(0)) return (false, 0);
        try pyth.getPriceNoOlderThan(id, maxAge) returns (PythStructs.Price memory p) {
            if (p.price <= 0 || !_confident(p)) return (false, 0);
            return (true, _toWad(p.price, p.expo));
        } catch {
            return (false, 0);
        }
    }

    /// @notice Last known price with its publish time, without freshness checks.
    /// @dev Never reverts for a configured key: a feed that was never pushed on-chain (common for
    ///      pull feeds on Mezo) returns (0, 0) so views stay usable; risk checks use `getPrice`.
    function getPriceUnsafe(bytes32 key) external view returns (uint256 priceWad, uint256 publishTime) {
        try pyth.getPriceUnsafe(_id(key)) returns (PythStructs.Price memory p) {
            if (p.price <= 0) return (0, p.publishTime);
            return (_toWad(p.price, p.expo), p.publishTime);
        } catch {
            return (0, 0);
        }
    }

    function _confident(PythStructs.Price memory p) internal view returns (bool) {
        return uint256(p.conf) * BPS <= uint256(uint64(p.price)) * maxConfBps;
    }

    function _id(bytes32 key) internal view returns (bytes32 id) {
        id = feeds[key];
        if (id == bytes32(0)) revert UnknownFeed();
    }

    function _toWad(int64 price, int32 expo) internal pure returns (uint256) {
        uint256 p = uint256(uint64(price));
        int256 shift = 18 + int256(expo);
        if (shift >= 0) return p * 10 ** uint256(shift);
        return p / 10 ** uint256(-shift);
    }
}
