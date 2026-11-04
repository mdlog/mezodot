// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PToken} from "../../src/hub/PToken.sol";
import {ITigrisPool} from "../../src/interfaces/ITigrisPool.sol";
import {ITigrisLiquidity} from "../../script/DeployPMusdPool.s.sol";

/// @notice pMUSD has 24 decimals and MUSD 18. A stable Tigris pool must price them near 1:1 regardless, and must carry
///         a pool's whole lifecycle. Nothing is broadcast. Skipped unless MEZO_FORK_RPC is set:
///         MEZO_FORK_RPC=https://rpc.test.mezo.org forge test --match-contract ForkPMusdPool -vv
contract ForkPMusdPoolTest is Test {
    address internal constant MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address payable internal constant PMUSD = payable(0x3E6F3719E919cF0Dc01d3019B8df913C472fDfB0);
    ITigrisLiquidity internal constant ROUTER = ITigrisLiquidity(0x9a1ff7FE3a0F69959A3fBa1F1e5ee18e1A9CD7E9);
    address internal constant FACTORY = 0x4947243CC818b627A5D06d14C4eCe7398A23Ce1A;

    uint256 internal constant SIDE = 1_000e18;
    uint256 internal constant ONE_SHARE = 1e24;

    address internal lp = makeAddr("lp");
    PToken internal share = PToken(PMUSD);
    IERC20 internal musd = IERC20(MUSD);
    ITigrisPool internal pool;

    function _fork() internal {
        string memory rpc = vm.envOr("MEZO_FORK_RPC", string(""));
        vm.skip(bytes(rpc).length == 0, "set MEZO_FORK_RPC to run Mezo fork tests");
        vm.createSelectFork(rpc);
        deal(MUSD, lp, SIDE * 3);
        vm.startPrank(lp);
        musd.approve(PMUSD, SIDE * 2);
        share.deposit(SIDE * 2, lp);
        musd.approve(address(ROUTER), type(uint256).max);
        share.approve(address(ROUTER), type(uint256).max);
        // A stable pool's first deposit must be equal once decimals are normalised.
        ROUTER.addLiquidity(PMUSD, MUSD, true, SIDE * 1e6, SIDE, SIDE * 1e6, SIDE, lp, block.timestamp);
        vm.stopPrank();
        pool = ITigrisPool(ROUTER.poolFor(PMUSD, MUSD, true, FACTORY));
    }

    function test_quotesNearPar_acrossTheDecimalGap() public {
        _fork();
        uint256 rate = share.convertToAssets(ONE_SHARE);
        // One whole share and one whole MUSD each buy about one of the other: 1% covers the fee, impact and interest.
        assertApproxEqRel(pool.getAmountOut(ONE_SHARE, PMUSD), rate, 0.01e18);
        assertApproxEqRel(pool.getAmountOut(1e18, MUSD), ONE_SHARE, 0.01e18);
    }

    function test_swapsBothWays() public {
        _fork();
        address trader = makeAddr("trader");
        deal(MUSD, trader, 10e18);
        vm.startPrank(trader);
        musd.approve(address(ROUTER), type(uint256).max);
        share.approve(address(ROUTER), type(uint256).max);

        ITigrisLiquidity.Route[] memory route = new ITigrisLiquidity.Route[](1);
        route[0] = ITigrisLiquidity.Route(MUSD, PMUSD, true, FACTORY);
        uint256[] memory bought = ROUTER.swapExactTokensForTokens(10e18, 0, route, trader, block.timestamp);
        assertApproxEqRel(bought[1], 10 * ONE_SHARE, 0.01e18);

        route[0] = ITigrisLiquidity.Route(PMUSD, MUSD, true, FACTORY);
        uint256[] memory sold = ROUTER.swapExactTokensForTokens(bought[1], 0, route, trader, block.timestamp);
        assertApproxEqRel(sold[1], 10e18, 0.01e18);
        assertLe(sold[1], 10e18, "a round trip pays the fee");
        vm.stopPrank();
    }

    function test_liquidityComesBackOut() public {
        _fork();
        vm.startPrank(lp);
        uint256 liquidity = IERC20(address(pool)).balanceOf(lp);
        IERC20(address(pool)).approve(address(ROUTER), liquidity);
        uint256 musdBefore = musd.balanceOf(lp);
        (uint256 shares, uint256 assets) =
            ROUTER.removeLiquidity(PMUSD, MUSD, true, liquidity, 0, 0, lp, block.timestamp);
        vm.stopPrank();
        assertApproxEqRel(assets, SIDE, 0.001e18);
        assertEq(musd.balanceOf(lp) - musdBefore, assets);
        assertGt(share.convertToAssets(shares), SIDE * 999 / 1000);
    }
}
