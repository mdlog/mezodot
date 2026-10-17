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
        if (feePaid > 0) pyth.updatePriceFeeds{value: feePaid}(updates);
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
        if (uint256(p.conf) * BPS > uint256(uint64(p.price)) * maxConfBps) revert PriceUncertain();
        return _toWad(p.price, p.expo);
    }

    /// @notice Last known price with its publish time, without freshness checks.
    function getPriceUnsafe(bytes32 key) external view returns (uint256 priceWad, uint256 publishTime) {
        PythStructs.Price memory p = pyth.getPriceUnsafe(_id(key));
        if (p.price <= 0) return (0, p.publishTime);
        return (_toWad(p.price, p.expo), p.publishTime);
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
