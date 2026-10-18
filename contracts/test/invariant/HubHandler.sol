// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MezodotPool} from "../../src/hub/MezodotPool.sol";
import {PToken} from "../../src/hub/PToken.sol";
import {VaultManager} from "../../src/hub/VaultManager.sol";
import {OracleRouter} from "../../src/hub/OracleRouter.sol";
import {LeverageManager} from "../../src/hub/LeverageManager.sol";
import {SwapLeverageManager} from "../../src/hub/SwapLeverageManager.sol";
import {KeeperGateway} from "../../src/hub/KeeperGateway.sol";
import {WormholeAdapter} from "../../src/hub/WormholeAdapter.sol";
import {SpokeGateway} from "../../src/spoke/SpokeGateway.sol";
import {IWormhole} from "../../src/interfaces/IWormhole.sol";
import {ITigrisRouter} from "../../src/interfaces/ITigrisRouter.sol";
import {Payload} from "../../src/libraries/Payload.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockTigrisPool} from "../mocks/MockTigrisPool.sol";
import {MockTigrisRouter} from "../mocks/MockTigrisRouter.sol";
import {MockFlashBorrower} from "../mocks/MockFlashBorrower.sol";
import {VaaSigner} from "../utils/VaaSigner.sol";

/// Everything HubHandler drives; deployed by HubInvariantTest.
struct HubSystem {
    VaultManager vaultManager;
    OracleRouter oracle;
    PToken pMUSD;
    PToken pMEZO;
    MockERC20 musd;
    MockERC20 mezo;
    MockERC20 btc;
    LeverageManager lev;
    SwapLeverageManager swapLev;
    KeeperGateway gateway;
    MockTigrisPool pair;
    MockTigrisRouter router;
    WormholeAdapter adapter;
    IWormhole hubWormhole;
    IWormhole spokeWormhole;
    SpokeGateway spoke;
    /// Spoke-side (Base) tokens behind the remote collateral ids.
    MockERC20 weth;
    MockERC20 usdc;
    uint256 musdMarket;
    uint256 mezoMarket;
    uint256 pMusdCollateral;
    uint256 pMezoCollateral;
    uint256 wethBase;
    uint256 usdcBase;
    uint256 btcCollateral;
    address treasury;
    /// Seed supplier of both pools.
    address lp;
    uint256 guardianKey;
    uint16 hubChain;
    uint16 spokeChain;
}

/// Price controls on the test contract, which owns the MockPyth feeds. Assets: 0 MEZO, 1 ETH, 2 BTC.
interface IHubPrices {
    function refreshPrices() external;
    function setPrice(uint256 asset, int64 price) external;
    function price(uint256 asset) external view returns (int64);
    function taggedPriceUpdates() external view returns (bytes[] memory);
}

/// @notice Random sequences over the whole hub: pool supply, BTC and spoke collateral, borrow and repay, price shocks,
///         direct and keeper liquidations (write-offs and the treasury's cut included), flash loans, the MUSD loop and
///         its netted unwind, BTC leverage through a Tigris flash swap, repay-with-collateral, reserve admin,
///         collateral toggles, delayed RELEASE delivery under a non-zero hub Wormhole fee, Tigris arbitrage and time.
/// @dev Every action bounds its inputs and returns early, or catches the revert, when it cannot run. Checks that need
///      the state both before and after a call run inside the action and are recorded as violations, which the
///      invariants assert are zero: a handler revert would be silently discarded (`fail_on_revert = false`).
///      Recorded logs include those of reverted calls, so logs are consumed after every successful call (`_flush`)
///      and discarded after every failed one (`_drop`): the ghost ledgers only ever see committed events.
contract HubHandler is Test {
    /// Families of in-action checks, reported through `violations`.
    enum Check {
        ExchangeRate,
        TigrisK,
        BadDebt,
        Liquidation,
        FlashLoan,
        BorrowLimit,
        Refund,
        Reserves,
        CrossChain,
        Accounting
    }

    /// A RELEASE the hub published and the spoke has not executed yet.
    struct Release {
        bytes vaa;
        address token;
        uint256 amount;
    }

    /// State around one liquidation, read before it runs.
    struct LiquidationCase {
        address account;
        uint256 pool;
        uint256 id;
        /// Pays the debt asset and receives the collateral (on the hub, or on the spoke for remote ids).
        address payer;
        bool remote;
        uint256 owed;
        uint256 posted;
        uint256 postedValue;
        uint256 treasuryBalance;
        uint256 payerAsset;
        uint256 payerNative;
        uint256 received;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;

    HubSystem internal s;
    IHubPrices internal immutable fixture;
    /// Owner of the pools, VaultManager and oracle (the test contract).
    address internal immutable owner;
    MockFlashBorrower public immutable flashBorrower;
    address public immutable liquidator;
    address public immutable keeper;
    address public immutable trader;
    address public immutable reserveSink;
    address[] public actors;
    int64[3] internal _basePrice;

    // --- Ghost state ------------------------------------------------------------------------------------------
    /// Exchange rate per pool (0 pMUSD, 1 pMEZO) at the end of the last action.
    uint256[2] public rateFloor;
    bool[2] internal _wroteOff;
    /// Tigris pool reserve0 × reserve1 at the end of the last action.
    uint256 public lastK;
    /// Expected totalReserves: Σ interest × reserve factor + flash fees − withdrawals − write-off losses taken by reserves.
    uint256[2] public reserveLedger;
    uint256[2] internal _reserveFactor;
    /// Debt changes (borrow, repay, write-off, accrual): each can move Σ debts against totalBorrows by under a wei.
    uint256[2] public debtEvents;
    /// Σ over accruals of totalBorrows / borrowIndex: bounds the index-truncation dust totalBorrows keeps.
    uint256[2] public truncationDust;
    /// Spoke token amounts the hub has released (debited) whose RELEASE the spoke has not executed yet.
    mapping(address token => uint256) public inFlight;
    Release[] internal _releases;
    bytes internal _depositVaa;
    uint256[10] internal _violations;
    string public firstViolation;

    // --- Coverage ---------------------------------------------------------------------------------------------
    uint256 public liquidations;
    uint256 public keeperLiquidations;
    uint256 public writeOffs;
    uint256 public flashLoans;
    uint256 public loops;
    uint256 public unwinds;
    uint256 public partialUnwinds;
    uint256 public opens;
    uint256 public closes;
    uint256 public partialCloses;
    uint256 public collateralRepays;
    uint256 public reserveWithdrawals;
    uint256 public remoteDeposits;
    uint256 public remoteWithdrawals;
    uint256 public releasesRelayed;
    uint256 public priceShocks;
    uint256 public trades;
    uint256 public warps;

    constructor(HubSystem memory system) {
        s = system;
        fixture = IHubPrices(msg.sender);
        owner = msg.sender;
        flashBorrower = new MockFlashBorrower();
        address liq = makeAddr("hub-liquidator");
        address kpr = makeAddr("hub-keeper");
        address trd = makeAddr("hub-trader");
        (liquidator, keeper, trader) = (liq, kpr, trd);
        reserveSink = makeAddr("hub-reserve-sink");
        for (uint256 i = 0; i < 4; i++) {
            actors.push(makeAddr(string.concat("hub-actor", vm.toString(i))));
            _setUpAccount(actors[i]);
        }
        _setUpAccount(liq);
        _setUpAccount(kpr);
        _setUpAccount(system.treasury);
        vm.startPrank(trd);
        system.musd.approve(address(system.router), type(uint256).max);
        system.btc.approve(address(system.router), type(uint256).max);
        vm.stopPrank();
        for (uint256 a = 0; a < 3; a++) {
            _basePrice[a] = IHubPrices(msg.sender).price(a);
        }
        for (uint256 p = 0; p < 2; p++) {
            rateFloor[p] = _pool(p).exchangeRate();
            reserveLedger[p] = _pool(p).totalReserves();
            _reserveFactor[p] = _pool(p).reserveFactor();
        }
        lastK = _k();
    }

    /// The fuzzed entrypoints. A selector listed twice is picked twice as often: liquidations need an unhealthy
    /// account, so they and the moves that create one (shocks, levered positions) get extra weight.
    function actions() external pure returns (bytes4[] memory a) {
        a = new bytes4[](30);
        a[0] = HubHandler.supplyAndPost.selector;
        a[1] = HubHandler.supplyAndPost.selector;
        a[2] = HubHandler.depositRemote.selector;
        a[3] = HubHandler.borrow.selector;
        a[4] = HubHandler.borrow.selector;
        a[5] = HubHandler.repay.selector;
        a[6] = HubHandler.withdrawCollateral.selector;
        a[7] = HubHandler.redeemShares.selector;
        a[8] = HubHandler.shockPrice.selector;
        a[9] = HubHandler.shockPrice.selector;
        a[10] = HubHandler.liquidate.selector;
        a[11] = HubHandler.liquidate.selector;
        a[12] = HubHandler.liquidate.selector;
        a[13] = HubHandler.liquidateViaKeeper.selector;
        a[14] = HubHandler.liquidateViaKeeper.selector;
        a[15] = HubHandler.liquidateViaKeeper.selector;
        a[16] = HubHandler.flashLoan.selector;
        a[17] = HubHandler.loop.selector;
        a[18] = HubHandler.unwind.selector;
        a[19] = HubHandler.openBtc.selector;
        a[20] = HubHandler.openBtc.selector;
        a[21] = HubHandler.closeBtc.selector;
        a[22] = HubHandler.repayWithCollateral.selector;
        a[23] = HubHandler.setReserveFactor.selector;
        a[24] = HubHandler.withdrawReserves.selector;
        a[25] = HubHandler.setCollateralEnabled.selector;
        a[26] = HubHandler.tradeTigris.selector;
        a[27] = HubHandler.relayRelease.selector;
        a[28] = HubHandler.warp.selector;
        a[29] = HubHandler.warp.selector;
    }

    modifier step() {
        vm.recordLogs(); // fresh window: logs left over from a reverted handler call are discarded
        _;
        _flush();
        _afterStep();
    }

    // =========================================================================
    // Collateral
    // =========================================================================

    /// Supplies MUSD or MEZO and posts the pTokens, or posts BTC as plain collateral.
    function supplyAndPost(uint256 seed, uint256 kind, uint256 amount) external step {
        address a = _actor(seed);
        kind %= 3;
        uint256 id = kind == 0 ? s.pMusdCollateral : kind == 1 ? s.pMezoCollateral : s.btcCollateral;
        if (!s.vaultManager.collaterals(id).enabled) return; // disabled collateral takes no deposits
        if (kind == 2) {
            amount = bound(amount, 0.001e18, 5e18);
            s.btc.mint(a, amount);
            vm.prank(a);
            s.vaultManager.depositCollateral(id, amount);
            return;
        }
        PToken pool = _pool(kind);
        amount = kind == 0 ? bound(amount, 1e18, 200_000e18) : bound(amount, 10_000e18, 20_000_000e18);
        MockERC20(pool.asset()).mint(a, amount);
        vm.startPrank(a);
        uint256 shares = pool.deposit(amount, a);
        s.vaultManager.depositCollateral(id, shares);
        vm.stopPrank();
    }

    /// Locks WETH or USDC on the Base spoke; the keeper relays the DEPOSIT to the hub through KeeperGateway.
    function depositRemote(uint256 seed, uint256 kind, uint256 amount) external step {
        address a = _actor(seed);
        MockERC20 token = kind % 2 == 0 ? s.weth : s.usdc;
        amount = address(token) == address(s.weth) ? bound(amount, 0.01e18, 50e18) : bound(amount, 10e6, 200_000e6);
        token.mint(a, amount);
        vm.prank(a);
        s.spoke.deposit(address(token), amount);
        _flush(); // signs the DEPOSIT into _depositVaa
        bytes memory vaa = _depositVaa;
        vm.prank(keeper);
        try s.gateway.relayMessage(vaa) {
            _flush();
            remoteDeposits++;
        } catch {
            _drop();
            _fail(Check.CrossChain, "hub refused a spoke DEPOSIT");
        }
    }

    /// Withdraws collateral (an actor, or the treasury taking its liquidation fees). Remote ids publish a RELEASE,
    /// which msg.value pays for together with any price updates.
    function withdrawCollateral(uint256 seed, uint256 kind, uint256 amount, uint256 payFlags) external step {
        (address a, uint256 id, bool found) = _accountHolding(seed, kind);
        if (!found) return;
        uint256 balance = s.vaultManager.collateralBalance(a, id);
        amount = amount % 4 == 0 ? balance : bound(amount, 1, balance);
        if (!s.vaultManager.collaterals(id).isRemote) {
            vm.prank(a);
            try s.vaultManager.withdrawCollateral(id, amount, a, new bytes[](0)) {
                _flush();
                _checkWithinLimit(a, "withdrawCollateral");
            } catch {
                _drop();
            }
            return;
        }
        (bytes[] memory updates, uint256 spent, uint256 value) = _payment(payFlags, s.adapter.messageFee());
        uint256 nativeBefore = a.balance;
        vm.prank(a);
        try s.vaultManager.withdrawRemote{value: value}(id, amount, Payload.toBytes32(a), updates) {
            _flush();
            remoteWithdrawals++;
            _checkWithinLimit(a, "withdrawRemote");
            _checkRefund(a, nativeBefore, spent, "withdrawRemote");
        } catch {
            _drop();
        }
    }

    /// Redeems pTokens a wallet holds (suppliers, liquidators, the keeper, the seed LP) as far as idle cash allows.
    function redeemShares(uint256 seed, uint256 poolSeed, uint256 shares) external step {
        address h = _holder(seed);
        PToken pool = _pool(poolSeed % 2);
        uint256 max = pool.maxRedeem(h);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        vm.prank(h);
        try pool.redeem(shares, h, h) {
            _flush();
        } catch {
            _drop();
        }
    }

    // =========================================================================
    // Debt
    // =========================================================================

    /// Borrows MUSD or MEZO, two times in three right up to the limit so that price moves make positions liquidatable.
    function borrow(uint256 seed, uint256 marketSeed, uint256 amount, uint256 payFlags) external step {
        address a = _actor(seed);
        uint256 p = marketSeed % 2;
        VaultManager.RiskSnapshot memory snap = s.vaultManager.getRiskSnapshot(a);
        if (snap.borrowLimit <= snap.debtValue) return;
        uint256 room = Math.min(_fromUsd(snap.borrowLimit - snap.debtValue, p), _pool(p).cash());
        if (room == 0) return;
        amount = amount % 3 != 0 ? room : bound(amount, 1, room);
        (bytes[] memory updates, uint256 spent, uint256 value) = _payment(payFlags, 0);
        uint256 nativeBefore = a.balance;
        vm.prank(a);
        try s.vaultManager.borrow{value: value}(_market(p), amount, updates) {
            _flush();
            _checkWithinLimit(a, "borrow");
            _checkRefund(a, nativeBefore, spent, "borrow");
        } catch {
            _drop();
        }
    }

    function repay(uint256 seed, uint256 marketSeed, uint256 amount) external step {
        (address a, uint256 p, bool found) = _actorOwing(seed, marketSeed);
        if (!found) return;
        PToken pool = _pool(p);
        uint256 owed = pool.borrowBalanceView(a);
        amount = amount % 3 == 0 ? type(uint256).max : bound(amount, 1, owed);
        MockERC20(pool.asset()).mint(a, Math.min(amount, owed));
        vm.prank(a);
        try s.vaultManager.repay(_market(p), amount, a) {
            _flush();
        } catch {
            _drop();
        }
    }

    /// Nets debt against the account's posted shares of the same pool: no cash moves.
    function repayWithCollateral(uint256 seed, uint256 marketSeed, uint256 amount) external step {
        (address a, uint256 p, bool found) = _actorNetting(seed, marketSeed);
        if (!found) return;
        PToken pool = _pool(p);
        uint256 id = _sharesId(p);
        uint256 posted = s.vaultManager.collateralBalance(a, id);
        uint256 owed = pool.borrowBalanceView(a);
        amount = amount % 3 == 0 ? type(uint256).max : bound(amount, 1, owed);
        uint256 cash = pool.cash();
        vm.prank(a);
        try s.vaultManager.repayWithCollateral(a, _market(p), id, amount) returns (uint256 repaid, uint256 burned) {
            _flush();
            collateralRepays++;
            if (pool.cash() != cash) _fail(Check.Accounting, "repayWithCollateral moved pool cash");
            if (repaid > owed || pool.borrowBalanceStored(a) != owed - repaid) {
                _fail(Check.Accounting, "repayWithCollateral: debt did not fall by the amount repaid");
            }
            if (burned > posted || s.vaultManager.collateralBalance(a, id) != posted - burned) {
                _fail(Check.Accounting, "repayWithCollateral: collateral did not fall by the shares burned");
            }
        } catch {
            _drop();
        }
    }

    // =========================================================================
    // Prices and liquidations
    // =========================================================================

    /// Moves MEZO, ETH or BTC alone, or (half of the time) all three together, by -70% … +50%: a mild downward drift
    /// that drives positions into liquidation and insolvency. Each price stays within 1/20× … 4× of its start.
    function shockPrice(uint256 assetSeed, uint256 bps) external step {
        bps = bound(bps, 3_000, 15_000);
        uint256 asset = assetSeed % 6;
        for (uint256 i = 0; i < 3; i++) {
            if (asset >= 3 || asset == i) _shock(i, bps);
        }
        priceShocks++;
    }

    function _shock(uint256 asset, uint256 bps) internal {
        uint256 base = SafeCast.toUint256(_basePrice[asset]);
        uint256 next = SafeCast.toUint256(fixture.price(asset)) * bps / BPS;
        next = Math.max(base / 20, Math.min(next, base * 4));
        fixture.setPrice(asset, SafeCast.toInt64(SafeCast.toInt256(next)));
    }

    /// Liquidates an unhealthy tracked account directly through VaultManager.
    function liquidate(uint256 seed, uint256 marketSeed, uint256 collateralSeed, uint256 amount) external step {
        (bool found, LiquidationCase memory c) = _liquidationCase(seed, marketSeed, collateralSeed, liquidator);
        if (!found) return;
        MockERC20 asset = MockERC20(_pool(c.pool).asset());
        uint256 cap = c.owed / 2; // close factor
        amount = amount % 3 == 0 ? type(uint256).max : bound(amount, 1, cap);
        asset.mint(liquidator, cap);
        _snapshotPayer(c);
        // Remote collateral is released on the spoke: the liquidator pays the hub's Wormhole fee.
        uint256 spent = c.remote ? s.adapter.messageFee() : 0;
        vm.prank(liquidator);
        try s.vaultManager.liquidate{value: spent}(
            c.account, _market(c.pool), amount, c.id, 0, liquidator, Payload.toBytes32(liquidator), new bytes[](0)
        ) returns (
            uint256 seized
        ) {
            _flush();
            liquidations++;
            _checkLiquidation(c, seized, spent);
        } catch {
            _drop();
        }
    }

    /// Liquidates through KeeperGateway, which pulls the repayment, returns what is unused and refunds all BTC.
    function liquidateViaKeeper(
        uint256 seed,
        uint256 marketSeed,
        uint256 collateralSeed,
        uint256 amount,
        uint256 payFlags
    ) external step {
        (bool found, LiquidationCase memory c) = _liquidationCase(seed, marketSeed, collateralSeed, keeper);
        if (!found) return;
        // Up to the whole debt: the gateway returns whatever the close factor leaves unused.
        amount = bound(amount, 1, c.owed);
        MockERC20(_pool(c.pool).asset()).mint(keeper, amount);
        _snapshotPayer(c);
        (bytes[] memory updates, uint256 spent, uint256 value) =
            _payment(payFlags, c.remote ? s.adapter.messageFee() : 0);
        vm.prank(keeper);
        try s.gateway.triggerLiquidation{value: value}(
            c.account, _market(c.pool), amount, c.id, 0, bytes32(0), updates
        ) returns (
            uint256 seized
        ) {
            _flush();
            keeperLiquidations++;
            _checkLiquidation(c, seized, spent);
        } catch {
            _drop();
        }
    }

    // =========================================================================
    // Flash loans and leverage
    // =========================================================================

    /// ERC-3156 loan of up to all idle cash, repaid with the 9 bps fee. Mode 1 supplies and redeems inside the
    /// callback; mode 2 checks that a paused pool refuses to lend.
    function flashLoan(uint256 poolSeed, uint256 amount, uint256 mode) external step {
        PToken pool = _pool(poolSeed % 2);
        uint256 cash = pool.cash();
        if (cash == 0) return;
        amount = bound(amount, 1, cash);
        mode %= 3;
        MockERC20 asset = MockERC20(pool.asset());
        uint256 fee = Math.mulDiv(amount, pool.FLASH_FEE_BPS(), BPS, Math.Rounding.Ceil);
        if (pool.flashFee(address(asset), amount) != fee) _fail(Check.FlashLoan, "flash fee is not 9 bps rounded up");
        // The borrower pays the fee from its own balance; the round trip can lose a few wei to share rounding.
        asset.mint(address(flashBorrower), fee + (mode == 1 ? 1e6 : 0));
        if (mode == 2) {
            vm.prank(owner);
            pool.pause();
            try flashBorrower.borrow(pool, amount, false) {
                _flush();
                _fail(Check.FlashLoan, "a paused pool lent a flash loan");
            } catch {
                _drop();
            }
            vm.prank(owner);
            pool.unpause();
            return;
        }
        uint256 rate = pool.exchangeRate();
        try flashBorrower.borrow(pool, amount, mode == 1) {
            _flush();
            flashLoans++;
            if (flashBorrower.lastFee() != fee) _fail(Check.FlashLoan, "the callback was charged another fee");
            if (flashBorrower.rateDuringLoan() != rate) {
                _fail(Check.FlashLoan, "share price moved while the flash loan was out");
            }
            if (mode == 0 && pool.exchangeRate() != rate) _fail(Check.FlashLoan, "a flash loan moved the share price");
        } catch {
            _drop();
            _fail(Check.FlashLoan, "a funded flash loan within idle cash reverted");
        }
    }

    /// The 1-click MUSD loop (flash borrow → supply → post → borrow the flash back). Over-levered loops revert.
    function loop(uint256 seed, uint256 principal, uint256 leverage, uint256 payFlags) external step {
        address a = _actor(seed);
        if (!s.vaultManager.collaterals(s.pMusdCollateral).enabled) return;
        principal = bound(principal, 10e18, 50_000e18);
        // Half of the loops sit close to the ≈ 4.98× that 80% LTV allows after the flash fee; past it they revert.
        leverage = principal % 2 == 0 ? bound(leverage, 4.5e18, 5e18) : bound(leverage, 1.05e18, 5e18);
        s.musd.mint(a, principal);
        (bytes[] memory updates, uint256 spent, uint256 value) = _payment(payFlags, 0);
        uint256 nativeBefore = a.balance;
        uint256 debtBefore = s.pMUSD.borrowBalanceView(a);
        uint256 postedBefore = s.vaultManager.collateralBalance(a, s.pMusdCollateral);
        vm.prank(a);
        try s.lev.loop{value: value}(principal, leverage, 0, updates) returns (uint256 shares, uint256 debt) {
            _flush();
            loops++;
            if (s.pMUSD.borrowBalanceStored(a) != debtBefore + debt) {
                _fail(Check.Accounting, "loop: debt did not grow by the reported debt");
            }
            if (s.vaultManager.collateralBalance(a, s.pMusdCollateral) != postedBefore + shares) {
                _fail(Check.Accounting, "loop: posted pMUSD did not grow by the reported shares");
            }
            _checkWithinLimit(a, "loop");
            _checkRefund(a, nativeBefore, spent, "loop");
        } catch {
            _drop();
        }
    }

    /// Unwinds the loop, fully (net all debt against posted pMUSD, withdraw everything) or partially; the pool pays
    /// out what idle cash allows and the rest comes back as pMUSD.
    function unwind(uint256 seed, uint256 mode, uint256 repayAmount, uint256 shares, uint256 payFlags) external step {
        (address a, bool found) = _actorHolding(seed, s.pMusdCollateral);
        if (!found) return;
        uint256 posted = s.vaultManager.collateralBalance(a, s.pMusdCollateral);
        bool full = mode % 3 == 0;
        if (full) {
            (repayAmount, shares) = (type(uint256).max, type(uint256).max);
        } else {
            uint256 owed = s.pMUSD.borrowBalanceView(a);
            repayAmount = owed == 0 ? 0 : bound(repayAmount, 0, owed);
            shares = bound(shares, 0, posted);
            if (repayAmount == 0 && shares == 0) return;
        }
        (bytes[] memory updates, uint256 spent, uint256 value) = _payment(payFlags, 0);
        uint256 nativeBefore = a.balance;
        uint256 musdBefore = s.musd.balanceOf(a);
        uint256 sharesBefore = s.pMUSD.balanceOf(a);
        vm.prank(a);
        try s.lev.unwind{value: value}(repayAmount, shares, 0, updates) returns (uint256 out, uint256 sharesReturned) {
            _flush();
            if (full) unwinds++;
            else partialUnwinds++;
            if (s.musd.balanceOf(a) != musdBefore + out) _fail(Check.Accounting, "unwind: MUSD out not paid");
            if (s.pMUSD.balanceOf(a) != sharesBefore + sharesReturned) {
                _fail(Check.Accounting, "unwind: unredeemed pMUSD not returned");
            }
            if (full && s.vaultManager.collateralBalance(a, s.pMusdCollateral) != 0) {
                _fail(Check.Accounting, "full unwind left pMUSD posted");
            }
            // Only a withdrawal is limit-checked; netting alone can leave an already-unhealthy account as it was.
            if ((!full && shares != 0) || out + sharesReturned != 0) _checkWithinLimit(a, "unwind");
            _checkRefund(a, nativeBefore, spent, "unwind");
        } catch {
            _drop();
        }
    }

    /// BTC leverage through the Tigris flash swap: post principal + bought BTC, borrow MUSD straight to the pool.
    function openBtc(uint256 seed, uint256 principal, uint256 borrowAmount, uint256 payFlags) external step {
        address a = _actor(seed);
        if (!s.vaultManager.collaterals(s.btcCollateral).enabled) return;
        principal = bound(principal, 0.01e18, 3e18);
        uint256 principalValue = Math.mulDiv(principal, _collateralPrice(s.btcCollateral), WAD);
        // 0.05× … 2.4× the principal in MUSD, two times in three 2.1× … 2.35×: past ≈ 2.33× (70% LTV, less swap fee
        // and price impact) the borrow check reverts the whole open.
        borrowAmount = principal % 3 != 0
            ? bound(borrowAmount, principalValue * 21 / 10, principalValue * 47 / 20 + 2)
            : bound(borrowAmount, principalValue / 20 + 1, principalValue * 12 / 5 + 2);
        if (borrowAmount > s.pMUSD.cash()) return;
        s.btc.mint(a, principal);
        (bytes[] memory updates, uint256 spent, uint256 value) = _payment(payFlags, 0);
        uint256 nativeBefore = a.balance;
        uint256 debtBefore = s.pMUSD.borrowBalanceView(a);
        uint256 postedBefore = s.vaultManager.collateralBalance(a, s.btcCollateral);
        vm.prank(a);
        try s.swapLev.open{value: value}(principal, borrowAmount, 0, block.timestamp, updates) returns (
            uint256 posted, uint256 debt
        ) {
            _flush();
            opens++;
            if (debt != borrowAmount || s.pMUSD.borrowBalanceStored(a) != debtBefore + debt) {
                _fail(Check.Accounting, "open: debt is not exactly the amount borrowed");
            }
            if (s.vaultManager.collateralBalance(a, s.btcCollateral) != postedBefore + posted) {
                _fail(Check.Accounting, "open: posted BTC is not principal + bought");
            }
            _checkWithinLimit(a, "open");
            _checkRefund(a, nativeBefore, spent, "open");
        } catch {
            _drop();
        }
    }

    /// Closes BTC leverage through the flash swap: fully (repay all, withdraw all) or partially. The sale is sized
    /// from the pool's own quote to cover the repayment.
    function closeBtc(uint256 seed, uint256 mode, uint256 repayAmount, uint256 withdrawAmount, uint256 payFlags)
        external
        step
    {
        (address a, bool found) = _actorLeveredInBtc(seed);
        if (!found) return;
        uint256 owed = s.pMUSD.borrowBalanceView(a);
        uint256 posted = s.vaultManager.collateralBalance(a, s.btcCollateral);
        bool full = mode % 3 == 0;
        uint256 repaid = full ? owed : bound(repayAmount, 1, owed);
        uint256 sell = _btcToSell(repaid);
        if (sell == 0 || sell > posted) return;
        uint256 withdrawn = full ? posted : bound(withdrawAmount, sell, posted);
        (bytes[] memory updates, uint256 spent, uint256 value) = _payment(payFlags, 0);
        uint256 nativeBefore = a.balance;
        uint256 btcBefore = s.btc.balanceOf(a);
        uint256 musdBefore = s.musd.balanceOf(a);
        vm.prank(a);
        try s.swapLev.close{value: value}(
            full ? type(uint256).max : repaid, full ? type(uint256).max : withdrawn, sell, 0, block.timestamp, updates
        ) returns (
            uint256 collateralOut, uint256 musdOut
        ) {
            _flush();
            if (full) closes++;
            else partialCloses++;
            if (s.pMUSD.borrowBalanceStored(a) != owed - repaid) {
                _fail(Check.Accounting, "close: debt did not fall by the repayment");
            }
            if (s.vaultManager.collateralBalance(a, s.btcCollateral) != posted - withdrawn) {
                _fail(Check.Accounting, "close: posted BTC did not fall by the withdrawal");
            }
            if (collateralOut != withdrawn - sell || s.btc.balanceOf(a) != btcBefore + collateralOut) {
                _fail(Check.Accounting, "close: unsold BTC not returned");
            }
            if (s.musd.balanceOf(a) != musdBefore + musdOut) {
                _fail(Check.Accounting, "close: sale surplus not returned");
            }
            _checkWithinLimit(a, "close");
            _checkRefund(a, nativeBefore, spent, "close");
        } catch {
            _drop();
        }
    }

    // =========================================================================
    // Admin, markets and time
    // =========================================================================

    function setReserveFactor(uint256 poolSeed, uint256 factor) external step {
        PToken pool = _pool(poolSeed % 2);
        factor = bound(factor, 0, pool.MAX_RESERVE_FACTOR());
        vm.prank(owner);
        pool.setReserveFactor(factor);
    }

    function withdrawReserves(uint256 poolSeed, uint256 amount) external step {
        PToken pool = _pool(poolSeed % 2);
        pool.accrueInterest(); // bound the amount by reserves as of now
        uint256 available = Math.min(pool.totalReserves(), pool.cash());
        if (available == 0) return;
        amount = bound(amount, 1, available);
        IERC20 asset = IERC20(pool.asset());
        uint256 sinkBefore = asset.balanceOf(reserveSink);
        _flush();
        vm.prank(owner);
        try pool.withdrawReserves(amount, reserveSink) {
            _flush();
            reserveWithdrawals++;
            if (asset.balanceOf(reserveSink) != sinkBefore + amount) {
                _fail(Check.Reserves, "withdrawReserves did not pay out the amount");
            }
        } catch {
            _drop();
            _fail(Check.Reserves, "the owner could not withdraw available reserves");
        }
    }

    /// Disables (one time in three) or re-enables a collateral. Disabled collateral keeps backing health, not borrowing.
    function setCollateralEnabled(uint256 idSeed, uint256 flag) external step {
        uint256 id = idSeed % s.vaultManager.collateralCount();
        VaultManager.CollateralConfig memory c = s.vaultManager.collaterals(id);
        vm.prank(owner);
        s.vaultManager.setCollateralParams(id, c.ltvBps, c.ltBps, c.bonusBps, c.cap, flag % 3 != 0);
    }

    /// An arbitrageur trades the Tigris pool 10% … 150% of the way to the oracle BTC price, through the router.
    function tradeTigris(uint256 fractionBps) external step {
        fractionBps = bound(fractionBps, 1_000, 15_000);
        (uint256 rBtc, uint256 rMusd) = _pairReserves();
        uint256 k = rBtc * rMusd;
        // Reserves on the same curve at the oracle price p (MUSD per BTC): rBtc' = sqrt(k / p).
        uint256 targetBtc = Math.sqrt(Math.mulDiv(k, WAD, _collateralPrice(s.btcCollateral)));
        bool buyBtc = targetBtc < rBtc; // BTC is cheaper in the pool than at the oracle
        uint256 amountIn = (buyBtc ? k / targetBtc - rMusd : targetBtc - rBtc) * fractionBps / BPS;
        if (amountIn == 0) return;
        (MockERC20 tokenIn, MockERC20 tokenOut) = buyBtc ? (s.musd, s.btc) : (s.btc, s.musd);
        tokenIn.mint(trader, amountIn);
        ITigrisRouter.Route[] memory routes = new ITigrisRouter.Route[](1);
        routes[0] = ITigrisRouter.Route({
            from: address(tokenIn), to: address(tokenOut), stable: false, factory: address(s.router)
        });
        vm.prank(trader);
        try s.router.swapExactTokensForTokens(amountIn, 0, routes, trader, block.timestamp) {
            _flush();
            trades++;
        } catch {
            _drop();
        }
    }

    /// Delivers one pending RELEASE (remote withdrawal or liquidation) to the spoke, in any order.
    function relayRelease(uint256 seed) external step {
        uint256 n = _releases.length;
        if (n == 0) return;
        uint256 i = seed % n;
        Release memory r = _releases[i];
        _releases[i] = _releases[n - 1];
        _releases.pop();
        try s.spoke.receiveMessage(r.vaa) {
            _flush();
            inFlight[r.token] = _minus(inFlight[r.token], r.amount, Check.CrossChain, "RELEASE larger than in flight");
            releasesRelayed++;
        } catch {
            _drop();
            _fail(Check.CrossChain, "spoke refused a RELEASE the hub published");
        }
    }

    function warp(uint256 secs) external step {
        secs = bound(secs, 1, 60 days);
        skip(secs);
        fixture.refreshPrices(); // keep risk-checked actions callable
        warps++;
    }

    // =========================================================================
    // Views for the invariants
    // =========================================================================

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    /// Every account that can hold collateral or debt: the actors, then the treasury.
    function trackedAccounts() external view returns (address[] memory accounts) {
        accounts = new address[](actors.length + 1);
        for (uint256 i = 0; i < actors.length; i++) {
            accounts[i] = actors[i];
        }
        accounts[actors.length] = s.treasury;
    }

    function violations(Check check) external view returns (uint256) {
        return _violations[uint256(check)];
    }

    function pendingReleases() external view returns (uint256) {
        return _releases.length;
    }

    /// BTC to sell through the Tigris pool for at least `musdOut` (what closeBtc sells).
    function quoteBtcToSell(uint256 musdOut) external view returns (uint256) {
        return _btcToSell(musdOut);
    }

    // =========================================================================
    // In-action checks
    // =========================================================================

    function _checkLiquidation(LiquidationCase memory c, uint256 seized, uint256 spent) internal {
        VaultManager.CollateralConfig memory cfg = s.vaultManager.collaterals(c.id);
        PToken pool = _pool(c.pool);
        uint256 taken = _minus(
            c.posted,
            s.vaultManager.collateralBalance(c.account, c.id),
            Check.Liquidation,
            "liquidation added collateral"
        );
        uint256 fee = _minus(
            s.vaultManager.collateralBalance(s.treasury, c.id),
            c.treasuryBalance,
            Check.Liquidation,
            "liquidation took treasury collateral"
        );
        if (taken != seized + fee) _fail(Check.Liquidation, "collateral taken != seized + protocol fee");
        if (fee != taken * cfg.bonusBps / (BPS + cfg.bonusBps) * s.vaultManager.liquidationFeeBps() / BPS) {
            _fail(Check.Liquidation, "protocol fee is not liquidationFeeBps of the bonus");
        }
        uint256 receivedNow = c.remote ? inFlight[_spokeToken(c.id)] : IERC20(cfg.token).balanceOf(c.payer);
        if (receivedNow != c.received + seized) {
            _fail(Check.Liquidation, "liquidator did not get the seized collateral");
        }
        uint256 paid = _minus(
            c.payerAsset, IERC20(pool.asset()).balanceOf(c.payer), Check.Liquidation, "liquidator was paid debt asset"
        );
        if (paid > c.owed / 2) _fail(Check.Liquidation, "repaid more than the close factor allows");
        // The liquidator gets at most the repaid value plus the bonus, and all of it while collateral is left.
        uint256 takenValue = Math.mulDiv(c.postedValue, taken, c.posted);
        uint256 dueValue = _toUsd(paid, c.pool) * (BPS + cfg.bonusBps) / BPS;
        uint256 slack = dueValue / 1e9 + 1e13; // unit rounding: one 6-decimal USDC unit is 1e12
        if (takenValue > dueValue + slack) _fail(Check.Liquidation, "seized more than the repayment plus bonus");
        if (taken < c.posted && takenValue + slack < dueValue) {
            _fail(Check.Liquidation, "seized less than the repayment plus bonus");
        }
        _checkRefund(c.payer, c.payerNative, spent, "liquidation");
        if (_hasCollateral(c.account)) {
            if (paid <= c.owed && pool.borrowBalanceStored(c.account) != c.owed - paid) {
                _fail(Check.Liquidation, "debt did not fall by the repayment");
            }
        } else if (_debtOf(c.account) != 0) {
            // The last collateral is gone: whatever is still owed, in every market, must have been written off.
            _fail(Check.BadDebt, "debt left on an account with no collateral after a liquidation");
        }
    }

    function _checkWithinLimit(address a, string memory what) internal {
        VaultManager.RiskSnapshot memory snap = s.vaultManager.getRiskSnapshot(a);
        if (snap.debtValue > snap.borrowLimit) {
            _fail(Check.BorrowLimit, string.concat(what, " left the account over its borrow limit"));
        }
    }

    /// The payer spent exactly `spent` (price-update fees and Wormhole fee); any excess msg.value came back.
    function _checkRefund(address payer, uint256 before, uint256 spent, string memory what) internal {
        if (payer.balance + spent != before) {
            _fail(Check.Refund, string.concat(what, " did not refund msg.value exactly"));
        }
    }

    function _afterStep() internal {
        for (uint256 p = 0; p < 2; p++) {
            uint256 rate = _pool(p).exchangeRate();
            if (_wroteOff[p]) {
                _wroteOff[p] = false; // suppliers absorbed bad debt: the price may fall here
            } else if (rate < rateFloor[p]) {
                _fail(
                    Check.ExchangeRate,
                    p == 0 ? "pMUSD rate fell without a write-off" : "pMEZO rate fell without a write-off"
                );
            }
            rateFloor[p] = rate;
        }
        uint256 k = _k();
        if (k < lastK) _fail(Check.TigrisK, "Tigris pool k decreased");
        lastK = k;
    }

    function _fail(Check check, string memory what) internal {
        _violations[uint256(check)]++;
        if (bytes(firstViolation).length == 0) firstViolation = what;
    }

    /// `a - b`, recording a violation instead of reverting (which would hide it) when it would underflow.
    function _minus(uint256 a, uint256 b, Check check, string memory what) internal returns (uint256) {
        if (b > a) {
            _fail(check, what);
            return 0;
        }
        return a - b;
    }

    // =========================================================================
    // Logs
    // =========================================================================

    /// Logs recorded since the last flush belong to calls that committed: account for them.
    function _flush() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            _onLog(logs[i]);
        }
    }

    /// Logs recorded since the last flush belong to a call that reverted: forget them.
    function _drop() internal {
        vm.getRecordedLogs();
    }

    function _onLog(Vm.Log memory l) internal {
        if (l.topics.length == 0) return;
        bytes32 topic = l.topics[0];
        if (l.emitter == address(s.pMUSD) || l.emitter == address(s.pMEZO)) {
            _onPoolLog(l.emitter == address(s.pMUSD) ? 0 : 1, topic, l.data);
        } else if (l.emitter == address(s.vaultManager)) {
            // Same signature as the pool's event; this one carries the market id.
            if (topic == VaultManager.BadDebtWrittenOff.selector) {
                _wroteOff[uint256(l.topics[2]) == s.musdMarket ? 0 : 1] = true;
                writeOffs++;
            }
        } else if (topic == IWormhole.LogMessagePublished.selector) {
            _onMessage(l.emitter, address(uint160(uint256(l.topics[1]))), l.data);
        }
    }

    function _onPoolLog(uint256 p, bytes32 topic, bytes memory data) internal {
        if (topic == MezodotPool.InterestAccrued.selector) {
            (uint256 interest, uint256 index, uint256 borrows,) = abi.decode(data, (uint256, uint256, uint256, uint256));
            reserveLedger[p] += interest * _reserveFactor[p] / WAD;
            truncationDust[p] += borrows / index + 2;
            debtEvents[p]++;
        } else if (topic == MezodotPool.FlashLoan.selector) {
            (, uint256 fee) = abi.decode(data, (uint256, uint256));
            reserveLedger[p] += fee;
        } else if (topic == MezodotPool.ReservesWithdrawn.selector) {
            reserveLedger[p] =
                _minus(reserveLedger[p], abi.decode(data, (uint256)), Check.Reserves, "withdrew unledgered reserves");
        } else if (topic == MezodotPool.BadDebtWrittenOff.selector) {
            (, uint256 fromReserves) = abi.decode(data, (uint256, uint256));
            reserveLedger[p] =
                _minus(reserveLedger[p], fromReserves, Check.Reserves, "write-off took unledgered reserves");
            debtEvents[p]++;
        } else if (topic == MezodotPool.ReserveFactorSet.selector) {
            _reserveFactor[p] = abi.decode(data, (uint256));
        } else if (topic == MezodotPool.Borrow.selector || topic == MezodotPool.RepayBorrow.selector) {
            debtEvents[p]++;
        }
    }

    /// Wormhole messages: hub RELEASEs go in flight until relayed; a spoke DEPOSIT is kept for immediate relay.
    function _onMessage(address core, address sender, bytes memory data) internal {
        (uint64 sequence,, bytes memory payload,) = abi.decode(data, (uint64, uint32, bytes, uint8));
        if (core == address(s.hubWormhole) && sender == address(s.adapter)) {
            Payload.Message memory m = Payload.decode(payload);
            address token = Payload.toAddress(m.token);
            inFlight[token] += m.amount;
            _releases.push(Release({vaa: _sign(s.hubChain, sender, sequence, payload), token: token, amount: m.amount}));
        } else if (core == address(s.spokeWormhole) && sender == address(s.spoke)) {
            _depositVaa = _sign(s.spokeChain, sender, sequence, payload);
        }
    }

    function _sign(uint16 chain, address emitter, uint64 sequence, bytes memory payload)
        internal
        view
        returns (bytes memory)
    {
        return VaaSigner.sign(vm, s.guardianKey, 0, chain, Payload.toBytes32(emitter), sequence, payload);
    }

    // =========================================================================
    // Helpers
    // =========================================================================

    function _setUpAccount(address a) internal {
        vm.deal(a, 100 ether); // native BTC for price-update and Wormhole fees
        vm.startPrank(a);
        s.musd.approve(address(s.pMUSD), type(uint256).max);
        s.musd.approve(address(s.vaultManager), type(uint256).max);
        s.musd.approve(address(s.lev), type(uint256).max);
        s.musd.approve(address(s.gateway), type(uint256).max);
        s.mezo.approve(address(s.pMEZO), type(uint256).max);
        s.mezo.approve(address(s.vaultManager), type(uint256).max);
        s.mezo.approve(address(s.gateway), type(uint256).max);
        s.btc.approve(address(s.vaultManager), type(uint256).max);
        s.btc.approve(address(s.swapLev), type(uint256).max);
        s.pMUSD.approve(address(s.vaultManager), type(uint256).max);
        s.pMEZO.approve(address(s.vaultManager), type(uint256).max);
        s.weth.approve(address(s.spoke), type(uint256).max);
        s.usdc.approve(address(s.spoke), type(uint256).max);
        s.vaultManager.setOperator(address(s.lev), true);
        s.vaultManager.setOperator(address(s.swapLev), true);
        vm.stopPrank();
    }

    // Actors are picked from `seed` onward, rotating to the first one the action applies to.

    function _actorHolding(uint256 seed, uint256 id) internal view returns (address a, bool found) {
        for (uint256 i = 0; i < actors.length; i++) {
            a = actors[(seed % actors.length + i) % actors.length];
            if (s.vaultManager.collateralBalance(a, id) != 0) return (a, true);
        }
    }

    /// An account (actors and treasury) holding some collateral, and its first id from `kind` with a balance.
    function _accountHolding(uint256 seed, uint256 kind) internal view returns (address a, uint256 id, bool found) {
        uint256 n = actors.length + 1;
        for (uint256 i = 0; i < n; i++) {
            a = _account(seed % n + i);
            for (uint256 j = 0; j < 5; j++) {
                id = _collateralId(kind % 5 + j);
                if (s.vaultManager.collateralBalance(a, id) != 0) return (a, id, true);
            }
        }
    }

    function _actorOwing(uint256 seed, uint256 marketSeed) internal view returns (address a, uint256 p, bool found) {
        for (uint256 i = 0; i < actors.length * 2; i++) {
            a = actors[(seed % actors.length + i / 2) % actors.length];
            p = (marketSeed % 2 + i) % 2;
            if (_pool(p).borrowBalanceView(a) != 0) return (a, p, true);
        }
    }

    /// An actor that owes in a pool whose shares it has posted (what repayWithCollateral nets).
    function _actorNetting(uint256 seed, uint256 marketSeed) internal view returns (address a, uint256 p, bool found) {
        for (uint256 i = 0; i < actors.length * 2; i++) {
            a = actors[(seed % actors.length + i / 2) % actors.length];
            p = (marketSeed % 2 + i) % 2;
            if (_pool(p).borrowBalanceView(a) != 0 && s.vaultManager.collateralBalance(a, _sharesId(p)) != 0) {
                return (a, p, true);
            }
        }
    }

    function _actorLeveredInBtc(uint256 seed) internal view returns (address a, bool found) {
        for (uint256 i = 0; i < actors.length; i++) {
            a = actors[(seed % actors.length + i) % actors.length];
            if (s.vaultManager.collateralBalance(a, s.btcCollateral) != 0 && s.pMUSD.borrowBalanceView(a) != 0) {
                return (a, true);
            }
        }
    }

    /// First tracked account (from `seed`) with health below 1 that owes something liquidatable and holds collateral.
    function _liquidationCase(uint256 seed, uint256 marketSeed, uint256 collateralSeed, address payer)
        internal
        view
        returns (bool found, LiquidationCase memory c)
    {
        uint256 n = s.vaultManager.collateralCount();
        for (uint256 i = 0; i < actors.length; i++) {
            address a = actors[(seed % actors.length + i) % actors.length];
            if (s.vaultManager.getRiskSnapshot(a).healthFactor >= WAD) continue;
            c.pool = marketSeed % 2;
            // Debt below 2 wei cannot be liquidated: the close factor rounds it to zero.
            if (_pool(c.pool).borrowBalanceView(a) < 2) c.pool = 1 - c.pool;
            c.owed = _pool(c.pool).borrowBalanceView(a);
            if (c.owed < 2) continue;
            for (uint256 j = 0; j < n; j++) {
                uint256 id = (collateralSeed % n + j) % n;
                uint256 posted = s.vaultManager.collateralBalance(a, id);
                if (posted == 0) continue;
                c.account = a;
                c.id = id;
                c.payer = payer;
                c.remote = s.vaultManager.collaterals(id).isRemote;
                c.posted = posted;
                c.postedValue = s.vaultManager.collateralValue(a, id);
                c.treasuryBalance = s.vaultManager.collateralBalance(s.treasury, id);
                return (true, c);
            }
        }
    }

    function _snapshotPayer(LiquidationCase memory c) internal view {
        c.payerAsset = IERC20(_pool(c.pool).asset()).balanceOf(c.payer);
        c.payerNative = c.payer.balance;
        c.received =
            c.remote ? inFlight[_spokeToken(c.id)] : IERC20(s.vaultManager.collaterals(c.id).token).balanceOf(c.payer);
    }

    /// msg.value for a call that must pay `required` (e.g. the Wormhole fee). flags % 4: 0 exact, no updates;
    /// 1 price updates paid exactly; 2 price updates plus excess; 3 excess without updates (all of it refunded).
    function _payment(uint256 flags, uint256 required)
        internal
        view
        returns (bytes[] memory updates, uint256 spent, uint256 value)
    {
        uint256 mode = flags % 4;
        updates = new bytes[](0);
        if (mode == 1 || mode == 2) {
            updates = fixture.taggedPriceUpdates();
            spent = s.oracle.updateFee(updates);
        }
        spent += required;
        value = spent + (mode >= 2 ? bound(flags >> 2, 1, 1e15) : 0);
    }

    /// BTC the Tigris pool swaps for at least `musdOut` at its current reserves and fee; 0 if it cannot.
    function _btcToSell(uint256 musdOut) internal view returns (uint256 sell) {
        (uint256 rBtc, uint256 rMusd) = _pairReserves();
        if (musdOut >= rMusd) return 0;
        // getAmountOut(a) ≥ out ⇔ a·(1 − fee) ≥ out·rBtc / (rMusd − out); round both steps up.
        uint256 net = Math.mulDiv(musdOut, rBtc, rMusd - musdOut, Math.Rounding.Ceil) + 1;
        sell = Math.mulDiv(net, BPS, BPS - s.pair.feeBps(), Math.Rounding.Ceil) + 1;
        if (s.pair.getAmountOut(sell, address(s.btc)) < musdOut) return 0;
    }

    function _pairReserves() internal view returns (uint256 rBtc, uint256 rMusd) {
        (uint256 r0, uint256 r1,) = s.pair.getReserves();
        (rBtc, rMusd) = s.pair.token0() == address(s.btc) ? (r0, r1) : (r1, r0);
    }

    function _k() internal view returns (uint256) {
        (uint256 r0, uint256 r1,) = s.pair.getReserves();
        return r0 * r1;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// Accounts that hold collateral: the actors and the treasury (liquidation fees).
    function _account(uint256 seed) internal view returns (address) {
        uint256 i = seed % (actors.length + 1);
        return i == actors.length ? s.treasury : actors[i];
    }

    /// Wallets that can hold pTokens: the actors, the liquidator, the keeper and the seed LP.
    function _holder(uint256 seed) internal view returns (address) {
        uint256 i = seed % (actors.length + 3);
        if (i < actors.length) return actors[i];
        if (i == actors.length) return liquidator;
        return i == actors.length + 1 ? keeper : s.lp;
    }

    function _collateralId(uint256 kind) internal view returns (uint256) {
        kind %= 5;
        if (kind == 0) return s.pMusdCollateral;
        if (kind == 1) return s.pMezoCollateral;
        if (kind == 2) return s.btcCollateral;
        return kind == 3 ? s.wethBase : s.usdcBase;
    }

    /// Collateral id of pool `p`'s own shares.
    function _sharesId(uint256 p) internal view returns (uint256) {
        return p == 0 ? s.pMusdCollateral : s.pMezoCollateral;
    }

    function _pool(uint256 p) internal view returns (PToken) {
        return p == 0 ? s.pMUSD : s.pMEZO;
    }

    function _market(uint256 p) internal view returns (uint256) {
        return p == 0 ? s.musdMarket : s.mezoMarket;
    }

    function _toUsd(uint256 amount, uint256 p) internal view returns (uint256) {
        VaultManager.Market memory m = s.vaultManager.markets(_market(p));
        (uint256 price,) = s.oracle.getPriceUnsafe(m.priceKey);
        return Math.mulDiv(amount, price, 10 ** m.decimals);
    }

    function _fromUsd(uint256 usd, uint256 p) internal view returns (uint256) {
        VaultManager.Market memory m = s.vaultManager.markets(_market(p));
        (uint256 price,) = s.oracle.getPriceUnsafe(m.priceKey);
        return Math.mulDiv(usd, 10 ** m.decimals, price);
    }

    function _collateralPrice(uint256 id) internal view returns (uint256 price) {
        (price,) = s.oracle.getPriceUnsafe(s.vaultManager.collaterals(id).priceKey);
    }

    function _spokeToken(uint256 id) internal view returns (address) {
        return address(uint160(uint256(s.vaultManager.collaterals(id).remoteToken)));
    }

    function _hasCollateral(address a) internal view returns (bool) {
        uint256 n = s.vaultManager.collateralCount();
        for (uint256 id = 0; id < n; id++) {
            if (s.vaultManager.collateralBalance(a, id) != 0) return true;
        }
        return false;
    }

    function _debtOf(address a) internal view returns (uint256) {
        return s.pMUSD.borrowBalanceStored(a) + s.pMEZO.borrowBalanceStored(a);
    }
}
