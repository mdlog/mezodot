// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TroveRouter} from "../../src/hub/TroveRouter.sol";
import {PToken} from "../../src/hub/PToken.sol";
import {VaultManager} from "../../src/hub/VaultManager.sol";
import {OracleRouter} from "../../src/hub/OracleRouter.sol";
import {PythSource} from "../../src/oracle/PythSource.sol";
import {SkipSource, IAggregatorV3} from "../../src/oracle/SkipSource.sol";
import {TigrisTwapSource} from "../../src/oracle/TigrisTwapSource.sol";
import {IPriceSource} from "../../src/oracle/IPriceSource.sol";
import {ITigrisTwapPool} from "../../src/interfaces/ITigrisPool.sol";
import {IBorrowerOperationsSignatures} from "../../src/interfaces/IBorrowerOperationsSignatures.sol";
import {MockSkipFeed} from "../mocks/MockSkipFeed.sol";

interface IEip712 {
    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory);
    function getNonce(address user) external view returns (uint256);
}

interface ITroveManager {
    function getTroveStatus(address borrower) external view returns (uint8);
    function getEntireDebtAndColl(address borrower)
        external
        view
        returns (uint256 coll, uint256 principal, uint256 interest, uint256, uint256, uint256);
}

interface IHintHelpers {
    function getApproxHint(uint256 cr, uint256 trials, uint256 seed) external view returns (address, uint256, uint256);
}

interface ISortedTroves {
    function findInsertPosition(uint256 nicr, address prev, address next) external view returns (address, address);
}

/// @notice TroveRouter against Mezo's real trove contracts and the live pMUSD market, with real EIP-712 signatures.
///         Nothing is broadcast. Skipped unless MEZO_FORK_RPC is set:
///         MEZO_FORK_RPC=https://rpc.test.mezo.org forge test --match-contract ForkTrove -vv
///         Forge cannot execute Mezo's Skip precompile, so a stand-in reporting the live price is etched over it.
contract ForkTroveTest is Test {
    address internal constant SIGNATURES = 0xD757e3646AF370b15f32EB557F0F8380Df7D639e;
    address internal constant TROVE_MANAGER = 0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0;
    address internal constant HINT_HELPERS = 0x4e4cBA3779d56386ED43631b4dCD6d8EacEcBCF6;
    address internal constant SORTED_TROVES = 0x722E4D24FD6Ff8b0AC679450F3D91294607268fA;
    address internal constant SKIP = 0x7b7c000000000000000000000000000000000015;
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address payable internal constant PMUSD = payable(0x3E6F3719E919cF0Dc01d3019B8df913C472fDfB0);
    address internal constant VAULT_MANAGER = 0x7a2e248Aa4799B3A6ef16a647E4F88A512B854F7;
    address internal constant ORACLE_ROUTER = 0x5d676a3F6477651C7BdE6442D0FD08aDf0b2eaeD;
    address internal constant PYTH_SOURCE = 0x2418E20877E72add21E383a8dD434938FDcCEbe4;
    address internal constant TIGRIS_MUSD_BTC = 0xd16A5Df82120ED8D626a1a15232bFcE2366d6AA9;
    address internal constant TIGRIS_MEZO_MUSD = 0x8eb88d745B0aFFF9D71AbC40d7F550Cded7bB342;
    bytes32 internal constant PYTH_MUSD = 0x0617a9b725011a126a2b9fd53563f4236501f32cf76d877644b943394606c6de;
    bytes32 internal constant PYTH_MEZO = 0x80beaaedbdd228e77c5d62dfcd74b0305674b7e27a5cc6a46e71bd3a696826df;
    uint256 internal constant PMUSD_COLLATERAL = 0;

    bytes32 internal constant OPEN_TYPEHASH = keccak256(
        "OpenTrove(uint256 assetAmount,uint256 debtAmount,address borrower,address recipient,uint256 nonce,uint256 deadline)"
    );
    bytes32 internal constant REPAY_TYPEHASH =
        keccak256("RepayMUSD(uint256 amount,address borrower,uint256 nonce,uint256 deadline)");
    bytes32 internal constant CLOSE_TYPEHASH =
        keccak256("CloseTrove(address borrower,address recipient,uint256 nonce,uint256 deadline)");

    uint256 internal constant KEY = 0xA11CE;
    uint256 internal constant DEBT = 2_500e18;
    uint256 internal constant BTC = 0.1e18;
    uint256 internal constant STATUS_ACTIVE = 1;

    address internal alice;
    TroveRouter internal router;
    PToken internal pool = PToken(PMUSD);
    uint256 internal livePrice;

    function _fork() internal {
        string memory rpc = vm.envOr("MEZO_FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0, "set MEZO_FORK_RPC to run Mezo fork tests");
        vm.createSelectFork(rpc);
        alice = vm.addr(KEY);
        vm.deal(alice, 1e18);
        int256 answer = vm.envOr("MEZO_FORK_BTC_USD", int256(77_750e18));
        livePrice = uint256(answer);
        MockSkipFeed feed = new MockSkipFeed(18);
        vm.etch(SKIP, address(feed).code);
        MockSkipFeed(SKIP).set(answer, block.timestamp);
        router = new TroveRouter(
            IBorrowerOperationsSignatures(SIGNATURES), VaultManager(VAULT_MANAGER), pool, PMUSD_COLLATERAL
        );
    }

    function _sign(bytes32 typeHash, bytes memory data, uint256 deadline) internal view returns (bytes memory) {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) =
            IEip712(SIGNATURES).eip712Domain();
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(abi.encodePacked(typeHash, data, IEip712(SIGNATURES).getNonce(alice), deadline));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    /// Insert position for a trove of `coll` BTC and `debt` total debt, as a client finds it.
    function _hints(uint256 coll, uint256 debt) internal view returns (address upper, address lower) {
        uint256 nicr = coll * 1e20 / debt;
        (address approx,,) = IHintHelpers(HINT_HELPERS).getApproxHint(nicr, 40, 7);
        return ISortedTroves(SORTED_TROVES).findInsertPosition(nicr, approx, approx);
    }

    function _open(bool post) internal returns (uint256 shares) {
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(OPEN_TYPEHASH, abi.encode(BTC, DEBT, alice, address(router)), deadline);
        (address upper, address lower) = _hints(BTC, DEBT + 200e18 + DEBT / 1000);
        vm.prank(alice);
        shares = router.openAndSupply{value: BTC}(DEBT, upper, lower, sig, deadline, 0, post);
    }

    function _debt() internal view returns (uint256) {
        (, uint256 principal, uint256 interest,,,) = ITroveManager(TROVE_MANAGER).getEntireDebtAndColl(alice);
        return principal + interest;
    }

    function test_open_makesARealTroveAndRealSupply() public {
        _fork();
        uint256 supplyBefore = pool.totalAssets();
        uint256 shares = _open(false);
        assertEq(ITroveManager(TROVE_MANAGER).getTroveStatus(alice), STATUS_ACTIVE);
        (uint256 coll,,,,,) = ITroveManager(TROVE_MANAGER).getEntireDebtAndColl(alice);
        assertEq(coll, BTC);
        assertEq(pool.balanceOf(alice), shares);
        assertApproxEqAbs(pool.convertToAssets(shares), DEBT, 1e6);
        assertGe(pool.totalAssets(), supplyBefore + DEBT - 1);
        assertEq(IERC20(MUSD).balanceOf(address(router)), 0);
        console2.log("trove debt after open", _debt() / 1e18);
    }

    function test_open_postsRealCollateral() public {
        _fork();
        vm.prank(alice);
        VaultManager(VAULT_MANAGER).setOperator(address(router), true);
        uint256 shares = _open(true);
        assertEq(VaultManager(VAULT_MANAGER).collateralBalance(alice, PMUSD_COLLATERAL), shares);
    }

    function test_open_refusesASignatureForAnotherAmount() public {
        _fork();
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(OPEN_TYPEHASH, abi.encode(BTC, DEBT, alice, address(router)), deadline);
        vm.prank(alice);
        vm.expectRevert("BorrowerOperationsSignatures: Invalid signature");
        router.openAndSupply{value: BTC}(DEBT + 1, address(0), address(0), sig, deadline, 0, false);
    }

    function test_repay_paysARealTroveFromSupply() public {
        _fork();
        _open(false);
        vm.prank(alice);
        IERC20(PMUSD).approve(address(router), type(uint256).max);
        uint256 debtBefore = _debt();
        uint256 deadline = block.timestamp + 600;
        uint256 amount = 100e18;
        bytes memory sig = _sign(REPAY_TYPEHASH, abi.encode(amount, alice), deadline);
        (address upper, address lower) = _hints(BTC, debtBefore - amount);
        vm.prank(alice);
        router.repayFromSupply(amount, upper, lower, sig, deadline, type(uint256).max);
        assertApproxEqAbs(_debt(), debtBefore - amount, 1e16);
    }

    function test_close_returnsTheBtcAndReturnsWhatIsLeft() public {
        _fork();
        uint256 shares = _open(false);
        vm.warp(block.timestamp + 1 days);
        MockSkipFeed(SKIP).set(int256(livePrice), block.timestamp);
        // Top up the borrowing fee and a day of interest from the wallet, as the app does.
        uint256 owed = _debt() - 200e18;
        uint256 fromWallet = owed - pool.convertToAssets(shares) + 1e18;
        deal(MUSD, alice, fromWallet);
        vm.startPrank(alice);
        IERC20(PMUSD).approve(address(router), type(uint256).max);
        IERC20(MUSD).approve(address(router), fromWallet);
        vm.stopPrank();
        uint256 deadline = block.timestamp + 600;
        bytes memory sig = _sign(CLOSE_TYPEHASH, abi.encode(alice, alice), deadline);
        uint256 balance = alice.balance;
        vm.prank(alice);
        (, uint256 refunded) = router.closeFromSupply(shares, fromWallet, sig, deadline);
        assertEq(alice.balance, balance + BTC);
        assertEq(pool.balanceOf(alice), 0);
        assertEq(IERC20(MUSD).balanceOf(alice), refunded);
        assertApproxEqAbs(refunded, 1e18, 1e16);
        assertGt(uint256(ITroveManager(TROVE_MANAGER).getTroveStatus(alice)), STATUS_ACTIVE);
    }

    // ------------------------------------------------------------------ oracle

    function _sources() internal returns (TigrisTwapSource twap) {
        _fork();
        SkipSource skipLeg = new SkipSource(IAggregatorV3(SKIP), 18);
        twap = new TigrisTwapSource(
            TigrisTwapSource.Config({
                anchor: IPriceSource(PYTH_SOURCE),
                btcUsd: skipLeg,
                btcMaxAge: 120,
                anchorMaxAge: 3_900,
                btcPool: ITigrisTwapPool(TIGRIS_MUSD_BTC),
                mezoPool: ITigrisTwapPool(TIGRIS_MEZO_MUSD),
                musd: MUSD,
                anchorMusd: PYTH_MUSD,
                anchorMezo: PYTH_MEZO,
                musdBandBps: 300,
                mezoBandBps: 1_500
            })
        );
    }

    function test_twap_servesMusdWhenThePushGoesStaleOnTheLiveRouter() public {
        TigrisTwapSource twap = _sources();
        (uint256 price, uint256 conf, uint256 time) = twap.latest(twap.MUSD_ID());
        console2.log("MUSD/USD fallback, 1e-6 units", price / 1e12);
        console2.log("spot-to-window gap, 1e-6 units", conf / 1e12);
        assertApproxEqRel(price, 1e18, 0.03e18);
        assertLt(time, block.timestamp);

        OracleRouter oracle = OracleRouter(ORACLE_ROUTER);
        uint8 tag = 4;
        vm.startPrank(oracle.owner());
        oracle.setSource(tag, twap);
        bytes32 key = keccak256("MUSD");
        OracleRouter.Feed memory feed = oracle.feeds(key);
        feed.secondary = OracleRouter.Leg({source: tag, maxAge: 3_900, id: twap.MUSD_ID()});
        feed.maxDivergenceBps = 500;
        oracle.setFeed(key, feed);
        vm.stopPrank();

        // A fresh push is still what the router serves.
        (, uint256 pushed, uint256 pushedAt) = (0, 0, 0);
        (pushed,, pushedAt) = IPriceSource(PYTH_SOURCE).latest(PYTH_MUSD);
        if (block.timestamp - pushedAt <= 3_900) assertEq(oracle.getPrice(key), pushed);

        // Past the push's max age, with the BTC feed alive, the fallback serves instead of the market reverting.
        vm.warp(pushedAt + 3_901);
        MockSkipFeed(SKIP).set(int256(livePrice), block.timestamp);
        uint256 served = oracle.getPrice(key);
        assertApproxEqRel(served, 1e18, 0.03e18);
        assertTrue(served != pushed);
    }

    function test_twap_doesNotServeTheMispricedTestnetMezoPool() public {
        TigrisTwapSource twap = _sources();
        (uint256 price,, uint256 time) = twap.latest(twap.MEZO_ID());
        console2.log("MEZO/USD fallback, 1e-6 units", price / 1e12);
        assertEq(price, 0);
        assertEq(time, 0);
    }
}
