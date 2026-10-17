// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {InterestRateModel} from "./InterestRateModel.sol";
import {MezodotPool} from "./MezodotPool.sol";

/// @title PToken
/// @notice ERC-4626 yield-bearing receipt (pMUSD / pMEZO). The vault is also the lending pool:
///         borrower interest raises `totalAssets`, so each share redeems for more underlying over time.
/// @dev Uses a 6-decimal virtual share offset against first-depositor inflation attacks;
///      share decimals are therefore underlying decimals + 6.
contract PToken is ERC4626, MezodotPool {
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        InterestRateModel irm,
        uint256 reserveFactor_,
        address owner_
    ) ERC20(name_, symbol_) ERC4626(asset_) MezodotPool(irm, reserveFactor_, owner_) {}

    function _underlying() internal view override returns (IERC20) {
        return IERC20(asset());
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    function totalAssets() public view override returns (uint256) {
        return _poolAssets();
    }

    /// @notice Underlying assets redeemable for one whole share (10**decimals()).
    function exchangeRate() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    // --- Limits ----------------------------------------------------------------

    function maxDeposit(address) public view override returns (uint256) {
        if (paused()) return 0;
        if (supplyCap == type(uint256).max) return type(uint256).max;
        uint256 assets = totalAssets();
        return assets >= supplyCap ? 0 : supplyCap - assets;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 assets = maxDeposit(receiver);
        if (assets == type(uint256).max) return type(uint256).max;
        return _convertToShares(assets, Math.Rounding.Floor);
    }

    /// @notice Withdrawals are limited by idle liquidity (cash).
    function maxWithdraw(address owner_) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner_), cash());
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner_), _convertToShares(cash(), Math.Rounding.Floor));
    }

    // --- Entry points: accrue first so previews use up-to-date state ---------

    function deposit(uint256 assets, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        accrueInterest();
        return super.deposit(assets, receiver);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant whenNotPaused returns (uint256) {
        accrueInterest();
        return super.mint(shares, receiver);
    }

    function withdraw(uint256 assets, address receiver, address owner_) public override nonReentrant returns (uint256) {
        accrueInterest();
        return super.withdraw(assets, receiver, owner_);
    }

    function redeem(uint256 shares, address receiver, address owner_) public override nonReentrant returns (uint256) {
        accrueInterest();
        return super.redeem(shares, receiver, owner_);
    }
}
