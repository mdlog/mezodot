// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceSource} from "./IPriceSource.sol";
import {ITigrisTwapPool} from "../interfaces/ITigrisPool.sol";

/// @title TigrisTwapSource
/// @notice A keyless fallback price for MUSD and MEZO, built only from Mezo's own infrastructure: its Skip BTC/USD
///         feed and time-weighted reserves of the Tigris MUSD/BTC and MEZO/MUSD pools.
///         MUSD/USD = BTC/USD ÷ (MUSD per BTC). MEZO/USD = (MUSD per MEZO) × MUSD/USD.
/// @dev This leg adds liveness and never overrides or blocks Mezo's Pyth push:
///      - While the push is fresh, it reports a publish time just older than the push, so OracleRouter serves the push.
///      - Once the push goes stale, it reports the current time and OracleRouter serves it.
///      - A price more than the band away from the last push is reported as missing, which leaves OracleRouter as it
///        would be without this leg. So a wrong or manipulated pool can move a price by at most the band, and only
///        during an outage of the push, and it cannot stop a fresh push from being served.
///      - The confidence is the gap between the pool's spot and windowed prices, so OracleRouter's confidence cap
///        refuses the leg while a pool is being pushed around.
///      Prices are windowed over at least 30 minutes of the pool's own observations, up to the current block. Both
///      pools must be volatile pools of 18-decimal tokens.
contract TigrisTwapSource is IPriceSource {
    struct Config {
        /// Mezo's push (PythSource): the anchor of the band and the leg this one stays behind.
        IPriceSource anchor;
        IPriceSource btcUsd;
        uint32 btcMaxAge;
        /// The max age OracleRouter gives the anchor's leg.
        uint32 anchorMaxAge;
        ITigrisTwapPool btcPool;
        ITigrisTwapPool mezoPool;
        address musd;
        bytes32 anchorMusd;
        bytes32 anchorMezo;
        uint16 musdBandBps;
        uint16 mezoBandBps;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    bytes32 public constant MUSD_ID = keccak256("MUSD");
    bytes32 public constant MEZO_ID = keccak256("MEZO");
    /// The shortest window a price averages over (the pools store one observation per 30-minute period).
    uint256 public constant MIN_WINDOW = 1_800;

    IPriceSource public immutable anchor;
    IPriceSource public immutable btcUsd;
    uint32 public immutable btcMaxAge;
    uint32 public immutable anchorMaxAge;
    ITigrisTwapPool public immutable btcPool;
    ITigrisTwapPool public immutable mezoPool;
    address public immutable musd;
    bytes32 public immutable anchorMusd;
    bytes32 public immutable anchorMezo;
    uint16 public immutable musdBandBps;
    uint16 public immutable mezoBandBps;

    error NoPullUpdates();

    constructor(Config memory c) {
        anchor = c.anchor;
        btcUsd = c.btcUsd;
        btcMaxAge = c.btcMaxAge;
        anchorMaxAge = c.anchorMaxAge;
        btcPool = c.btcPool;
        mezoPool = c.mezoPool;
        musd = c.musd;
        anchorMusd = c.anchorMusd;
        anchorMezo = c.anchorMezo;
        musdBandBps = c.musdBandBps;
        mezoBandBps = c.mezoBandBps;
    }

    function updateFee(bytes calldata) external pure returns (uint256) {
        return 0;
    }

    /// @dev Nothing to verify or store: the price is read from the pools.
    function update(bytes calldata) external payable {
        revert NoPullUpdates();
    }

    function latest(bytes32 id) external view returns (uint256 priceWad, uint256 confWad, uint256 publishTime) {
        uint256 spot;
        bytes32 anchorId;
        uint256 bandBps;
        if (id == MUSD_ID) {
            (priceWad, spot) = _musdUsd();
            (anchorId, bandBps) = (anchorMusd, musdBandBps);
        } else if (id == MEZO_ID) {
            (priceWad, spot) = _mezoUsd();
            (anchorId, bandBps) = (anchorMezo, mezoBandBps);
        }
        if (priceWad == 0) return (0, 0, 0);

        (uint256 anchorPrice,, uint256 anchorTime) = anchor.latest(anchorId);
        if (anchorPrice == 0 || anchorTime == 0) return (0, 0, 0);
        if (_absDiff(priceWad, anchorPrice) * BPS > anchorPrice * bandBps) return (0, 0, 0);

        confWad = _absDiff(priceWad, spot);
        publishTime = block.timestamp - anchorTime <= anchorMaxAge ? anchorTime - 1 : block.timestamp;
    }

    function _musdUsd() internal view returns (uint256 windowed, uint256 spot) {
        (uint256 price,, uint256 time) = btcUsd.latest(bytes32(0));
        if (price == 0 || block.timestamp - time > btcMaxAge) return (0, 0);
        (uint256 musdPerBtc, uint256 musdPerBtcSpot) = _musdPer(btcPool);
        if (musdPerBtc == 0 || musdPerBtcSpot == 0) return (0, 0);
        return (price * WAD / musdPerBtc, price * WAD / musdPerBtcSpot);
    }

    function _mezoUsd() internal view returns (uint256 windowed, uint256 spot) {
        (uint256 musdUsd, uint256 musdUsdSpot) = _musdUsd();
        if (musdUsd == 0) return (0, 0);
        (uint256 musdPerMezo, uint256 musdPerMezoSpot) = _musdPer(mezoPool);
        return (musdPerMezo * musdUsd / WAD, musdPerMezoSpot * musdUsdSpot / WAD);
    }

    /// @return windowed MUSD per unit of the pool's other token over at least MIN_WINDOW, in WAD; zero without history.
    /// @return spot The same at the current reserves.
    function _musdPer(ITigrisTwapPool pool) internal view returns (uint256 windowed, uint256 spot) {
        uint256 count = pool.observationLength();
        if (count < 2) return (0, 0);
        (uint256 cumulative0, uint256 cumulative1, uint256 nowTime) = pool.currentCumulativePrices();
        (uint256 time, uint256 start0, uint256 start1) = pool.observations(count - 1);
        if (nowTime - time < MIN_WINDOW) (time, start0, start1) = pool.observations(count - 2);
        uint256 elapsed = nowTime - time;
        if (elapsed == 0) return (0, 0);
        bool musdIsToken0 = pool.token0() == musd;
        windowed = _ratio(cumulative0 - start0, cumulative1 - start1, musdIsToken0, elapsed);
        (uint256 reserve0, uint256 reserve1,) = pool.getReserves();
        spot = _ratio(reserve0, reserve1, musdIsToken0, 1);
    }

    /// @dev Both amounts accumulate over the same time, so `elapsed` cancels when it is applied to both.
    function _ratio(uint256 amount0, uint256 amount1, bool musdIsToken0, uint256 elapsed)
        internal
        pure
        returns (uint256)
    {
        (uint256 musdAmount, uint256 other) = musdIsToken0 ? (amount0, amount1) : (amount1, amount0);
        other /= elapsed;
        return other == 0 ? 0 : (musdAmount / elapsed) * WAD / other;
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
