// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {OracleRouter} from "../../src/hub/OracleRouter.sol";
import {PythSource} from "../../src/oracle/PythSource.sol";
import {SupraSource, ISupraOraclePull} from "../../src/oracle/SupraSource.sol";
import {InterestRateModel} from "../../src/hub/InterestRateModel.sol";
import {PToken} from "../../src/hub/PToken.sol";
import {VaultManager} from "../../src/hub/VaultManager.sol";
import {LeverageManager} from "../../src/hub/LeverageManager.sol";
import {KeeperGateway} from "../../src/hub/KeeperGateway.sol";
import {WormholeAdapter} from "../../src/hub/WormholeAdapter.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Local fork simulations against real Mezo testnet oracle state (read-only RPC, nothing is broadcast),
///         using the deployed testnet oracle configuration. Skipped unless MEZO_FORK_RPC is set:
///         MEZO_FORK_RPC=https://rpc.test.mezo.org forge test --match-contract ForkMezo -vv
contract ForkMezoTest is Test {
    // Mezo testnet (verified 2026-10-17): Pyth Core after the 2026-08-26 cutover, pushed hourly by Mezo, and
    // Supra's DORA pull contract.
    address internal constant PYTH_CORE = 0x933aDeC2C7624b11E4B2b80ACE15BF9a71a31315;
    address internal constant SUPRA_PULL = 0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702;
    bytes32 internal constant MUSD_FEED = 0x0617a9b725011a126a2b9fd53563f4236501f32cf76d877644b943394606c6de;
    bytes32 internal constant MEZO_FEED = 0x80beaaedbdd228e77c5d62dfcd74b0305674b7e27a5cc6a46e71bd3a696826df;
    bytes32 internal constant ETH_FEED = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 internal constant USDC_FEED = 0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a;
    /// Block at which test/fixtures/supra_proof.hex (Supra pairs 18, 19, 48, 89, 0) was fetched.
    uint256 internal constant PINNED_BLOCK = 16_212_979;

    uint8 internal constant PYTH = 1;
    uint8 internal constant SUPRA = 2;
    bytes32 internal constant K_MUSD = keccak256("MUSD");
    bytes32 internal constant K_MEZO = keccak256("MEZO");
    bytes32 internal constant K_ETH = keccak256("ETH");
    bytes32 internal constant K_USDC = keccak256("USDC");

    OracleRouter internal router;

    /// Same feed table as the testnet deployment (contracts/.env.example).
    function _fork(uint256 blockNumber) internal {
        string memory rpc = vm.envOr("MEZO_FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0, "set MEZO_FORK_RPC to run Mezo fork tests");
        if (blockNumber == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, blockNumber);
        router = new OracleRouter(address(this));
        router.setSource(PYTH, new PythSource(IPyth(PYTH_CORE)));
        router.setSource(SUPRA, new SupraSource(ISupraOraclePull(SUPRA_PULL)));
        router.setFeed(K_MUSD, _feed(_leg(PYTH, 3_900, MUSD_FEED), _none(), 500, 0));
        router.setFeed(K_MEZO, _feed(_leg(PYTH, 3_900, MEZO_FEED), _none(), 500, 0));
        router.setFeed(K_USDC, _feed(_leg(PYTH, 3_900, USDC_FEED), _leg(SUPRA, 120, bytes32(uint256(89))), 200, 150));
        router.setFeed(K_ETH, _feed(_leg(PYTH, 120, ETH_FEED), _leg(SUPRA, 120, bytes32(uint256(19))), 200, 150));
    }

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

    function _supraUpdate() internal view returns (bytes[] memory u) {
        u = new bytes[](1);
        u[0] = abi.encodePacked(SUPRA, vm.parseBytes(vm.readFile("test/fixtures/supra_proof.hex")));
    }

    function _logAge(string memory label, bytes32 key) internal view {
        (uint256 p, uint256 t) = router.getPriceUnsafe(key);
        // Supra may publish up to 15 s ahead of the block: report that as age 0.
        console2.log(label, p, t == 0 || t > block.timestamp ? 0 : block.timestamp - t);
    }

    // ------------------------------------------------------------------ reads at the chain head

    function test_head_pushFeedsFreshWithPerKeyMaxAge() public {
        _fork(0);
        _logAge("MUSD wad / age s", K_MUSD);
        _logAge("MEZO wad / age s", K_MEZO);
        _logAge("USDC wad / age s", K_USDC);
        assertGt(router.getPrice(K_MUSD), 0.9e18);
        assertGt(router.getPrice(K_MEZO), 0);
        assertGt(router.getPrice(K_USDC), 0.9e18);
        // ETH is not pushed to Pyth on Mezo and no Supra proof was posted: unavailable (fail closed), views 0.
        (bool ok,) = router.tryGetPrice(K_ETH);
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ ETH paths at the pinned block

    function test_pinned_supraProofUnlocksEth() public {
        _fork(PINNED_BLOCK);
        bytes[] memory u = _supraUpdate();
        uint256 g = gasleft();
        router.updatePrices(u);
        console2.log("gas: router.updatePrices(Supra 5-pair proof)", g - gasleft());
        _logAge("ETH (Supra) wad / age s", K_ETH);
        assertEq(router.getPrice(K_ETH), 2_412.98e18);
        // USDC: Pyth primary (hourly push) is still fresh; Supra USDC is fresh too but > 60 s apart: no cross-check.
        assertGt(router.getPrice(K_USDC), 0.99e18);
    }

    function test_pinned_pythEthPayloadIsAcceptedByUpgradedCore() public {
        _fork(PINNED_BLOCK);
        // Signed ETH/USD update copied from Ethereum mainnet calldata (publishTime 1792256163, ~2 h old here):
        // models the agent's optional keyed pusher posting ETH to Pyth on Mezo.
        router.setFeed(K_ETH, _feed(_leg(PYTH, 3 hours, ETH_FEED), _leg(SUPRA, 120, bytes32(uint256(19))), 200, 150));
        bytes[] memory u = new bytes[](1);
        u[0] = abi.encodePacked(PYTH, vm.parseBytes(vm.readFile("test/fixtures/pyth_eth_update.hex")));
        assertEq(router.updateFee(u), 0); // Pyth on Mezo testnet charges no update fee
        router.updatePrices(u);
        _logAge("ETH (Pyth) wad / age s", K_ETH);
        assertApproxEqRel(router.getPrice(K_ETH), 2_398.877e18, 0.001e18);
    }

    // ------------------------------------------------------------------ full hub flows at the pinned block

    MockERC20 internal musd;
    MockERC20 internal mezo;
    PToken internal pMUSD;
    PToken internal pMEZO;
    VaultManager internal vaultManager;
    LeverageManager internal lev;
    KeeperGateway internal keepers;
    uint256 internal musdMarket;
    uint256 internal mezoMarket;
    uint256 internal pMusdColl;
    uint256 internal wethColl;
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal liquidator = makeAddr("liquidator");

    function _deployHub() internal {
        _fork(PINNED_BLOCK);
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
        vaultManager = new VaultManager(router, address(this));
        pMUSD.setVaultManager(address(vaultManager));
        pMEZO.setVaultManager(address(vaultManager));
        musdMarket = vaultManager.addMarket(pMUSD, K_MUSD);
        mezoMarket = vaultManager.addMarket(pMEZO, K_MEZO);
        pMusdColl = vaultManager.addCollateral(
            VaultManager.CollateralConfig({
                enabled: true,
                isRemote: false,
                token: address(pMUSD),
                chainId: 0,
                remoteToken: bytes32(0),
                decimals: 18,
                priceKey: K_MUSD,
                ltvBps: 8000,
                ltBps: 8500,
                bonusBps: 500,
                cap: type(uint256).max
            })
        );
        wethColl = vaultManager.addCollateral(
            VaultManager.CollateralConfig({
                enabled: true,
                isRemote: true,
                token: address(0),
                chainId: 10004,
                remoteToken: bytes32(uint256(uint160(0x4200000000000000000000000000000000000006))),
                decimals: 18,
                priceKey: K_ETH,
                ltvBps: 7500,
                ltBps: 8000,
                bonusBps: 700,
                cap: type(uint256).max
            })
        );
        vaultManager.setAdapter(address(this)); // this test plays the Wormhole adapter (credit + release stub)
        lev = new LeverageManager(vaultManager, pMUSD, musdMarket, pMusdColl);
        keepers = new KeeperGateway(vaultManager, WormholeAdapter(address(this)));

        musd.mint(lp, 1_000_000e18);
        mezo.mint(lp, 100_000_000e18);
        vm.startPrank(lp);
        musd.approve(address(pMUSD), type(uint256).max);
        mezo.approve(address(pMEZO), type(uint256).max);
        pMUSD.deposit(1_000_000e18, lp);
        pMEZO.deposit(100_000_000e18, lp);
        vm.stopPrank();
    }

    // IReleaseSender stub (VaultManager calls these on its adapter).
    function messageFee() external pure returns (uint256) {
        return 0;
    }

    function sendRelease(uint16, bytes32, bytes32, uint256) external payable returns (uint64) {
        return 1;
    }

    function creditAlice() external {
        vaultManager.creditRemote(alice, wethColl, 1e18);
    }

    function test_pinned_loopAndUnwindWithNoUpdateBytes() public {
        _deployHub();
        musd.mint(alice, 1_000e18);
        vm.startPrank(alice);
        musd.approve(address(lev), type(uint256).max);
        vaultManager.setOperator(address(lev), true);
        // MUSD comes from Mezo's hourly push on Pyth Core: no update bytes needed.
        (uint256 shares, uint256 debt) = lev.loop(1_000e18, 3e18, 0, new bytes[](0));
        assertGt(shares, 0);
        assertEq(debt, 2_001.8e18);
        uint256 out = lev.unwind(type(uint256).max, type(uint256).max, 0, new bytes[](0));
        vm.stopPrank();
        assertGt(out, 990e18);
    }

    function test_pinned_borrowWithdrawAndLiquidateAcrossSources() public {
        _deployHub();
        // Bob borrows MEZO against pMUSD: both prices from Pyth Core on Mezo, no update bytes.
        musd.mint(bob, 10_000e18);
        vm.startPrank(bob);
        musd.approve(address(pMUSD), type(uint256).max);
        uint256 shares = pMUSD.deposit(10_000e18, bob);
        IERC20(address(pMUSD)).approve(address(vaultManager), shares);
        vaultManager.depositCollateral(pMusdColl, shares);
        vaultManager.borrow(mezoMarket, 1_000_000e18, new bytes[](0)); // ~ $3k of MEZO vs ~ $7.9k limit
        vaultManager.withdrawCollateral(pMusdColl, shares / 4, bob, new bytes[](0)); // still within LTV
        vm.stopPrank();

        // Alice: 1 WETH locked on Base Sepolia, credited through the adapter.
        this.creditAlice();
        // Without an ETH price the remote collateral counts as zero for the limit, so the borrow reverts.
        vm.prank(alice);
        vm.expectRevert(VaultManager.InsufficientCollateral.selector);
        vaultManager.borrow(musdMarket, 1_500e18, new bytes[](0));
        // A keyless Supra proof in the same transaction unlocks it.
        bytes[] memory u = _supraUpdate();
        vm.prank(alice);
        uint256 g = gasleft();
        vaultManager.borrow(musdMarket, 1_500e18, u);
        console2.log("gas: VaultManager.borrow with Supra proof", g - gasleft());

        // A risk change makes Alice liquidatable; the keeper liquidates with the same fresh proof stored.
        vaultManager.setCollateralParams(wethColl, 5000, 5000, 700, type(uint256).max, true);
        musd.mint(liquidator, 1_000e18);
        vm.startPrank(liquidator);
        musd.approve(address(keepers), type(uint256).max);
        uint256 seized = keepers.triggerLiquidation(alice, musdMarket, 700e18, wethColl, 1, bytes32(0), new bytes[](0));
        vm.stopPrank();
        assertGt(seized, 0);
        console2.log("liquidation seized WETH wei", seized);
    }

    receive() external payable {}
}
