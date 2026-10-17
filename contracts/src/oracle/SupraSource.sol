// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IPriceSource} from "./IPriceSource.sol";
import {WadMath} from "./WadMath.sol";

/// @notice Subset of Supra's DORA pull contract (SupraOraclePull, verified source on Mezo testnet explorer).
interface ISupraOraclePull {
    struct PriceInfo {
        uint256[] pairs;
        uint256[] prices;
        uint256[] timestamp; // milliseconds
        uint256[] decimal;
        uint256[] round;
    }

    function verifyOracleProofV2(bytes calldata proof) external returns (PriceInfo memory);
}

/// @title SupraSource
/// @notice Keyless pull prices from Supra DORA (Mezo testnet pull contract 0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702).
///         Proofs come from Supra's public `get_proof` endpoint and are verified on-chain by Supra's committee keys.
/// @dev Supra enforces no maximum data age (only rounds ≤ 15 s in the future are rejected), so the router's
///      per-leg maxAge is the only freshness guard. Verified values are cached here instead of read back from
///      Supra's storage contract, so reads never depend on that contract's access rules.
contract SupraSource is IPriceSource {
    using SafeCast for uint256;

    struct Cached {
        uint192 priceWad;
        uint64 publishTime;
    }

    ISupraOraclePull public immutable pull;
    mapping(uint256 pair => Cached) internal _cache;

    event SupraPriceStored(uint256 indexed pair, uint256 priceWad, uint256 publishTime);

    error FeeNotAccepted();

    constructor(ISupraOraclePull pull_) {
        pull = pull_;
    }

    function updateFee(bytes calldata) external pure returns (uint256) {
        return 0;
    }

    function update(bytes calldata proof) external payable {
        if (msg.value != 0) revert FeeNotAccepted();
        // Reverts (DataNotVerified) unless the proof's Merkle root is signed by a Supra committee.
        ISupraOraclePull.PriceInfo memory info = pull.verifyOracleProofV2(proof);
        for (uint256 i = 0; i < info.pairs.length; i++) {
            uint256 publishTime = info.timestamp[i] / 1000;
            Cached storage c = _cache[info.pairs[i]];
            if (publishTime <= c.publishTime) continue; // keep only the newest value per pair
            uint256 priceWad = WadMath.fromDecimals(info.prices[i], info.decimal[i]);
            c.priceWad = priceWad.toUint192();
            c.publishTime = publishTime.toUint64();
            emit SupraPriceStored(info.pairs[i], priceWad, publishTime);
        }
    }

    /// @param id Supra pair index as bytes32 (ETH_USD = 19, USDC_USD = 89, BTC_USD = 18).
    function latest(bytes32 id) external view returns (uint256 priceWad, uint256 confWad, uint256 publishTime) {
        Cached memory c = _cache[uint256(id)];
        return (c.priceWad, 0, c.publishTime); // Supra publishes no confidence interval
    }
}
