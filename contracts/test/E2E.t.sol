// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CrossChainFixture} from "./utils/CrossChainFixture.sol";
import {DevWormhole} from "./mocks/DevWormhole.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {SpokeGateway} from "../src/spoke/SpokeGateway.sol";
import {LeverageManager} from "../src/hub/LeverageManager.sol";
import {KeeperGateway} from "../src/hub/KeeperGateway.sol";
import {VaultManager} from "../src/hub/VaultManager.sol";
import {Payload} from "../src/libraries/Payload.sol";

/// End-to-end PRD scenarios across the hub and two spokes (Base Sepolia + Ethereum Sepolia).
contract E2ETest is CrossChainFixture {
    DevWormhole internal ethWormhole;
    SpokeGateway internal ethSpoke;
    MockERC20 internal ethWeth;
    uint256 internal wethEth;
    LeverageManager internal lev;
    KeeperGateway internal keepers;

    address internal lpUser = makeAddr("lpUser");
    address internal borrower = makeAddr("borrower");
    address internal looper = makeAddr("looper");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        setUpCrossChain();
        ethWormhole = new DevWormhole(ETH_SEPOLIA, vm.addr(GUARDIAN_PK), 0);
        ethWeth = new MockERC20("Wrapped Ether", "WETH", 18);
        ethSpoke = new SpokeGateway(ethWormhole, MEZO_CHAIN, 1, address(this));
        ethSpoke.setToken(address(ethWeth), true, type(uint256).max);
        ethSpoke.setHubEmitter(Payload.toBytes32(address(adapter)));
        adapter.setSpoke(ETH_SEPOLIA, Payload.toBytes32(address(ethSpoke)));
        wethEth = vaultManager.addCollateral(
            _remote(ETH_SEPOLIA, Payload.toBytes32(address(ethWeth)), 18, ETH_KEY, 7500, 8000, 700)
        );

        lev = new LeverageManager(vaultManager, pMUSD, musdMarket, pMusdCollateral);
        keepers = new KeeperGateway(vaultManager, adapter);
    }

    /// Flow A: passive LP deposits 10,000 MUSD, receives pMUSD, and earns borrower interest.
    function test_flowA_passiveLp() public {
        uint256 shares = supplyFor(lpUser, pMUSD, 10_000e18);
        assertApproxEqAbs(pMUSD.convertToAssets(shares), 10_000e18, 1e6);
        // Generate borrower demand through the real cross-chain path, then let a year pass.
        keepers.relayMessage(spokeDeposit(borrower, weth, 300e18));
        vm.prank(borrower);
        vaultManager.borrow(musdMarket, 600_000e18, noUpdates());
        skip(365 days);
        assertGt(pMUSD.convertToAssets(shares), 10_200e18); // > 2% APY at ~60% utilisation
    }

    /// Flow B on two spokes: wETH on Base + Ethereum, borrow MUSD on Mezo, withdraw back to Ethereum.
    function test_flowB_multiSpokeBorrower() public {
        keepers.relayMessage(spokeDeposit(borrower, weth, 1.5e18));

        ethWeth.mint(borrower, 0.9e18);
        vm.startPrank(borrower);
        ethWeth.approve(address(ethSpoke), 0.9e18);
        vm.recordLogs();
        ethSpoke.deposit(address(ethWeth), 0.9e18);
        vm.stopPrank();
        keepers.relayMessage(signLast(ETH_SEPOLIA, address(ethSpoke)));

        VaultManager.RiskSnapshot memory s = vaultManager.getRiskSnapshot(borrower);
        assertEq(s.collateralValue, 2.4e18 * 3_200); // $7,680 across two chains
        vm.prank(borrower);
        vaultManager.borrow(musdMarket, 3_120e18, noUpdates());
        assertEq(musd.balanceOf(borrower), 3_120e18);

        vm.recordLogs();
        vm.prank(borrower);
        vaultManager.withdrawRemote(wethEth, 0.4e18, Payload.toBytes32(borrower), noUpdates());
        ethSpoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));
        assertEq(ethWeth.balanceOf(borrower), 0.4e18);
        assertGt(vaultManager.getRiskSnapshot(borrower).healthFactor, 1e18);
    }

    /// Flow C: degen looper, 1,000 MUSD at 3×, then unwind.
    function test_flowC_loopAndUnwind() public {
        musd.mint(looper, 1_000e18);
        vm.startPrank(looper);
        musd.approve(address(lev), type(uint256).max);
        vaultManager.setOperator(address(lev), true);
        (uint256 shares, uint256 debt) = lev.loop(1_000e18, 3e18, 0, noUpdates());
        assertApproxEqAbs(pMUSD.convertToAssets(shares), 3_000e18, 1e6);
        assertEq(debt, 2_001.8e18);
        skip(30 days);
        uint256 out = lev.unwind(type(uint256).max, type(uint256).max, 0, noUpdates());
        vm.stopPrank();
        assertGt(out, 990e18);
    }

    /// Remote collateral liquidated by a keeper; seized wETH delivered to the keeper on Base.
    function test_keeperLiquidatesRemoteCollateral() public {
        keepers.relayMessage(spokeDeposit(borrower, weth, 1e18));
        vm.prank(borrower);
        vaultManager.borrow(musdMarket, 2_350e18, noUpdates());
        ethPrice = 2_800e8;
        pushPrices();
        uint256 hfBefore = vaultManager.getRiskSnapshot(borrower).healthFactor;
        assertLt(hfBefore, 1e18);

        musd.mint(keeper, 5_000e18);
        vm.startPrank(keeper);
        musd.approve(address(keepers), type(uint256).max);
        vm.recordLogs();
        uint256 seized =
            keepers.triggerLiquidation(borrower, musdMarket, 1_175e18, wethBase, 1, bytes32(0), noUpdates());
        vm.stopPrank();
        spoke.receiveMessage(signLast(MEZO_CHAIN, address(adapter)));

        assertEq(weth.balanceOf(keeper), seized);
        // Keeper profit: seized value exceeds repaid MUSD by the 7% bonus.
        assertGt(seized * 2_800, 1_175e18 * 1_06 / 100);
        assertEq(keepers.keeperCount(), 2); // the test relayer + the keeper
        assertGt(vaultManager.getRiskSnapshot(borrower).healthFactor, hfBefore);
    }
}
