// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {IPriceSource} from "./IPriceSource.sol";
import {WadMath} from "./WadMath.sol";

/// @title PythSource
/// @notice Pyth Core on Mezo, used both as a push feed (prices stored by Mezo's pusher or the Mezodot agent)
///         and as a pull feed (a caller passes a signed Hermes update). On Mezo testnet this wraps the upgraded
///         Core contract 0x933aDeC2C7624b11E4B2b80ACE15BF9a71a31315 (fee 0); 0x2880… is no longer pushed to.
contract PythSource is IPriceSource {
    IPyth public immutable pyth;

    constructor(IPyth pyth_) {
        pyth = pyth_;
    }

    function updateFee(bytes calldata payload) external view returns (uint256) {
        return pyth.getUpdateFee(_wrap(payload));
    }

    /// @dev Pyth verifies the signatures (3-of-5 routers since the 2026-08-26 cutover) and keeps only
    ///      prices newer than the stored ones, so a replayed or older payload cannot move a price back.
    function update(bytes calldata payload) external payable {
        pyth.updatePriceFeeds{value: msg.value}(_wrap(payload));
    }

    function latest(bytes32 id) external view returns (uint256 priceWad, uint256 confWad, uint256 publishTime) {
        // getPriceUnsafe: the router applies its own per-key maxAge. Pyth's getPrice() would always revert
        // here because validTimePeriod is 60 s while Mezo's pusher runs hourly.
        try pyth.getPriceUnsafe(id) returns (PythStructs.Price memory p) {
            if (p.price <= 0) return (0, 0, 0);
            return (WadMath.fromExpo(uint64(p.price), p.expo), WadMath.fromExpo(p.conf, p.expo), p.publishTime);
        } catch {
            return (0, 0, 0); // PriceFeedNotFound: never pushed on this contract (ETH/USD on Mezo today)
        }
    }

    function _wrap(bytes calldata payload) private pure returns (bytes[] memory updates) {
        updates = new bytes[](1);
        updates[0] = payload;
    }
}
