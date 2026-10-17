// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {InterestRateModel} from "../../src/hub/InterestRateModel.sol";
import {PToken} from "../../src/hub/PToken.sol";
import {OracleRouter} from "../../src/hub/OracleRouter.sol";
import {VaultManager} from "../../src/hub/VaultManager.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Deploys a complete hub (tokens, pools, oracle, VaultManager) with spec parameters.
abstract contract HubFixture is Test {
    uint16 internal constant BASE_SEPOLIA = 10004;
    uint16 internal constant ETH_SEPOLIA = 10002;

    bytes32 internal constant MUSD_KEY = keccak256("MUSD");
    bytes32 internal constant MEZO_KEY = keccak256("MEZO");
    bytes32 internal constant ETH_KEY = keccak256("ETH");
    bytes32 internal constant USDC_KEY = keccak256("USDC");

    bytes32 internal constant MUSD_ID = bytes32(uint256(1));
    bytes32 internal constant MEZO_ID = bytes32(uint256(2));
    bytes32 internal constant ETH_ID = bytes32(uint256(3));
    bytes32 internal constant USDC_ID = bytes32(uint256(4));

    // Spoke token addresses as seen from the hub (universal 32-byte form).
    bytes32 internal constant SPOKE_WETH = bytes32(uint256(uint160(0x4200000000000000000000000000000000000006)));
    bytes32 internal constant SPOKE_USDC = bytes32(uint256(uint160(0x036CbD53842c5426634e7929541eC2318f3dCF7e)));

    MockERC20 internal musd;
    MockERC20 internal mezo;
    PToken internal pMUSD;
    PToken internal pMEZO;
    MockPyth internal pyth;
    OracleRouter internal oracle;
    VaultManager internal vaultManager;

    uint256 internal musdMarket;
    uint256 internal mezoMarket;
    uint256 internal pMusdCollateral;
    uint256 internal pMezoCollateral;
    uint256 internal wethBase;
    uint256 internal usdcBase;

    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal liquidator = makeAddr("liquidator");

    int64 internal ethPrice = 3_200e8;
    int64 internal mezoPrice = 794_000; // $0.00794 at expo -8
    int64 internal musdPrice = 1e8;
    int64 internal usdcPrice = 1e8;

    function setUpHub() internal {
        vm.warp(1_700_000_000);
        musd = new MockERC20("Mezo USD", "MUSD", 18);
        mezo = new MockERC20("Mezo", "MEZO", 18);
        pMUSD = new PToken(
            IERC20(address(musd)),
            "Mezodot MUSD",
            "pMUSD",
            new InterestRateModel(0, 0.06e18, 0.8e18, 0.8e18),
            0.1e18,
            address(this)
        );
        pMEZO = new PToken(
            IERC20(address(mezo)),
            "Mezodot MEZO",
            "pMEZO",
            new InterestRateModel(0.02e18, 0.08e18, 0.7e18, 1e18),
            0.1e18,
            address(this)
        );
        pyth = new MockPyth(60, 1);
        oracle = new OracleRouter(pyth, 120, 200, address(this));
        oracle.setFeed(MUSD_KEY, MUSD_ID);
        oracle.setFeed(MEZO_KEY, MEZO_ID);
        oracle.setFeed(ETH_KEY, ETH_ID);
        oracle.setFeed(USDC_KEY, USDC_ID);

        vaultManager = new VaultManager(oracle, address(this));
        pMUSD.setVaultManager(address(vaultManager));
        pMEZO.setVaultManager(address(vaultManager));
        musdMarket = vaultManager.addMarket(pMUSD, MUSD_KEY);
        mezoMarket = vaultManager.addMarket(pMEZO, MEZO_KEY);

        pMusdCollateral = vaultManager.addCollateral(_local(address(pMUSD), MUSD_KEY, 8000, 8500, 500));
        pMezoCollateral = vaultManager.addCollateral(_local(address(pMEZO), MEZO_KEY, 5000, 6000, 1000));
        wethBase = vaultManager.addCollateral(_remote(BASE_SEPOLIA, SPOKE_WETH, 18, ETH_KEY, 7500, 8000, 700));
        usdcBase = vaultManager.addCollateral(_remote(BASE_SEPOLIA, SPOKE_USDC, 6, USDC_KEY, 8000, 8500, 500));

        pushPrices();
        // Seed hub liquidity.
        supplyFor(lp, pMUSD, 1_000_000e18);
        supplyFor(lp, pMEZO, 500_000_000e18);
    }

    function _local(address token, bytes32 priceKey, uint16 ltv, uint16 lt, uint16 bonus)
        internal
        pure
        returns (VaultManager.CollateralConfig memory)
    {
        return VaultManager.CollateralConfig({
            enabled: true,
            isRemote: false,
            token: token,
            chainId: 0,
            remoteToken: bytes32(0),
            decimals: 18,
            priceKey: priceKey,
            ltvBps: ltv,
            ltBps: lt,
            bonusBps: bonus,
            cap: type(uint256).max
        });
    }

    function _remote(
        uint16 chainId,
        bytes32 token,
        uint8 decimals,
        bytes32 priceKey,
        uint16 ltv,
        uint16 lt,
        uint16 bonus
    ) internal pure returns (VaultManager.CollateralConfig memory) {
        return VaultManager.CollateralConfig({
            enabled: true,
            isRemote: true,
            token: address(0),
            chainId: chainId,
            remoteToken: token,
            decimals: decimals,
            priceKey: priceKey,
            ltvBps: ltv,
            ltBps: lt,
            bonusBps: bonus,
            cap: type(uint256).max
        });
    }

    /// Writes all four prices with the current timestamp directly into MockPyth.
    /// MockPyth ignores updates that are not newer than the stored one, so advance one second first.
    function pushPrices() internal {
        skip(1);
        bytes[] memory updates = priceUpdates();
        pyth.updatePriceFeeds{value: pyth.getUpdateFee(updates)}(updates);
    }

    function priceUpdates() internal view returns (bytes[] memory updates) {
        uint64 t = uint64(block.timestamp);
        updates = new bytes[](4);
        updates[0] = pyth.createPriceFeedUpdateData(MUSD_ID, musdPrice, 0, -8, musdPrice, 0, t);
        updates[1] = pyth.createPriceFeedUpdateData(MEZO_ID, mezoPrice, 0, -8, mezoPrice, 0, t);
        updates[2] = pyth.createPriceFeedUpdateData(ETH_ID, ethPrice, 0, -8, ethPrice, 0, t);
        updates[3] = pyth.createPriceFeedUpdateData(USDC_ID, usdcPrice, 0, -8, usdcPrice, 0, t);
    }

    function noUpdates() internal pure returns (bytes[] memory) {
        return new bytes[](0);
    }

    function supplyFor(address who, PToken pool, uint256 amount) internal returns (uint256 shares) {
        MockERC20 token = MockERC20(pool.asset());
        token.mint(who, amount);
        vm.startPrank(who);
        token.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    /// Supplies `amount` into `pool` and posts the resulting shares as collateral.
    function postLocal(address who, PToken pool, uint256 collateralId, uint256 amount)
        internal
        returns (uint256 shares)
    {
        shares = supplyFor(who, pool, amount);
        vm.startPrank(who);
        pool.approve(address(vaultManager), shares);
        vaultManager.depositCollateral(collateralId, shares);
        vm.stopPrank();
    }
}
