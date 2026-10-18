// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PToken} from "./PToken.sol";
import {OracleRouter} from "./OracleRouter.sol";
import {Payload} from "../libraries/Payload.sol";

interface IReleaseSender {
    function sendRelease(uint16 chainId, bytes32 token, bytes32 recipient, uint256 amount)
        external
        payable
        returns (uint64 sequence);
    function messageFee() external view returns (uint256);
}

/// @title VaultManager
/// @notice Source of truth for Mezodot positions across chains: collateral held on the hub
///         (escrowed pTokens, or plain tokens such as BTC) and on external spokes (credited via
///         verified Wormhole messages), debt in every hub market, LTV limits, health factors and
///         liquidations. A share of each liquidation bonus is kept for the protocol.
/// @dev Health factor = Σ(collateral value × liquidation threshold) / Σ debt value.
///      New debt and withdrawals require Σ(collateral value × LTV) ≥ debt afterwards.
///      All USD values are WAD. Risk-checked entrypoints accept Pyth price updates and refund unused BTC.
contract VaultManager is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 public constant CLOSE_FACTOR_BPS = 5_000;
    uint256 public constant MAX_COLLATERALS = 16;
    uint256 public constant MAX_MARKETS = 8;
    /// @notice The protocol can keep at most half of a liquidation bonus.
    uint16 public constant MAX_LIQUIDATION_FEE_BPS = 5_000;

    /// How prices are read when valuing a position.
    /// Strict: fresh and confident or revert (debt, liquidation).
    /// Conservative: unavailable collateral prices count as zero (borrow / withdraw limits).
    /// View: last known price, never reverts (read-only views).
    enum PriceMode {
        View,
        Conservative,
        Strict
    }

    struct CollateralConfig {
        bool enabled;
        bool isRemote;
        /// Local token is a pToken share, valued through its exchange rate; false for plain tokens (BTC) and remote.
        bool isShare;
        /// Local collateral token (pToken or plain token) or zero for remote collateral.
        address token;
        /// Wormhole chain id of the spoke (remote only).
        uint16 chainId;
        /// Spoke token address in universal 32-byte form (remote only).
        bytes32 remoteToken;
        /// Decimals of the priced unit: underlying decimals for pTokens, token decimals otherwise.
        uint8 decimals;
        bytes32 priceKey;
        uint16 ltvBps;
        uint16 ltBps;
        uint16 bonusBps;
        /// Maximum total balance in collateral units (shares for pTokens, token units otherwise).
        uint256 cap;
    }

    struct Market {
        PToken pool;
        bytes32 priceKey;
        uint8 decimals;
        bool enabled;
    }

    struct RiskSnapshot {
        uint256 collateralValue;
        /// Σ value × liquidation threshold.
        uint256 adjustedCollateral;
        /// Σ value × LTV.
        uint256 borrowLimit;
        uint256 debtValue;
        /// WAD; type(uint256).max when there is no debt.
        uint256 healthFactor;
    }

    OracleRouter public immutable oracle;
    address public adapter;
    /// @notice Account credited with the protocol's share of seized collateral (withdrawn like any collateral).
    address public treasury;
    /// @notice Protocol share of each liquidation bonus, in bps of the bonus (1_000 = 10%).
    uint16 public liquidationFeeBps;

    CollateralConfig[] internal _collaterals;
    Market[] internal _markets;

    mapping(address account => mapping(uint256 collateralId => uint256)) public collateralBalance;
    mapping(uint256 collateralId => uint256) public totalCollateral;
    mapping(address account => mapping(address operator => bool)) public isOperator;
    mapping(uint16 chainId => mapping(bytes32 token => uint256 idPlusOne)) public remoteCollateralId;
    mapping(address token => bool) internal _localListed;

    event CollateralAdded(uint256 indexed id, CollateralConfig config);
    event CollateralParamsSet(
        uint256 indexed id, uint16 ltvBps, uint16 ltBps, uint16 bonusBps, uint256 cap, bool enabled
    );
    event MarketAdded(uint256 indexed marketId, address pool, bytes32 priceKey);
    event AdapterSet(address adapter);
    event OperatorSet(address indexed account, address indexed operator, bool approved);
    event CollateralDeposited(address indexed account, uint256 indexed id, uint256 amount, address from);
    event CollateralWithdrawn(address indexed account, uint256 indexed id, uint256 amount, address to);
    event RemoteCredited(address indexed account, uint256 indexed id, uint256 amount);
    event RemoteWithdrawRequested(
        address indexed account, uint256 indexed id, uint256 amount, bytes32 recipient, uint64 sequence
    );
    event Borrowed(address indexed account, uint256 indexed marketId, uint256 amount, address receiver);
    event Repaid(address indexed account, uint256 indexed marketId, uint256 amount, address payer);
    event Liquidated(
        address indexed account,
        address indexed liquidator,
        uint256 indexed marketId,
        uint256 collateralId,
        uint256 repaid,
        uint256 seized
    );
    /// Debt left after the account's last collateral was seized, removed from the market (see MezodotPool.writeOff).
    event BadDebtWrittenOff(address indexed account, uint256 indexed marketId, uint256 amount);
    event TreasurySet(address treasury);
    event LiquidationFeeSet(uint16 bps);
    /// Collateral units of a liquidation kept for the protocol and credited to `treasury`.
    event LiquidationFeeTaken(address indexed account, uint256 indexed collateralId, uint256 amount, address treasury);
    /// Debt repaid by burning the account's posted shares of the same pool; no cash moved.
    event RepaidWithCollateral(
        address indexed account, uint256 indexed marketId, uint256 indexed collateralId, uint256 repaid, uint256 shares
    );

    error InvalidParams();
    error InvalidCollateral();
    error InvalidMarket();
    error CapExceeded();
    error InsufficientCollateral();
    error InsufficientBalance();
    error NotOperator();
    error NotAdapter();
    error NothingToRepay();
    error PositionHealthy();
    error SlippageExceeded();
    error ZeroAmount();
    error InsufficientValue();
    error RefundFailed();
    error AdapterAlreadySet();
    error InvalidRecipient();
    error WouldLeaveBadDebt();

    modifier onlyAdapter() {
        if (msg.sender != adapter) revert NotAdapter();
        _;
    }

    modifier onlyOperatorOf(address account) {
        if (msg.sender != account && !isOperator[account][msg.sender]) revert NotOperator();
        _;
    }

    constructor(OracleRouter oracle_, address owner_) Ownable(owner_) {
        oracle = oracle_;
        treasury = owner_;
    }

    // =========================================================================
    // Admin
    // =========================================================================

    function addCollateral(CollateralConfig calldata c) external onlyOwner returns (uint256 id) {
        if (_collaterals.length >= MAX_COLLATERALS) revert InvalidParams();
        _validateParams(c.ltvBps, c.ltBps, c.bonusBps);
        if (c.isRemote) {
            if (c.chainId == 0 || c.remoteToken == bytes32(0) || c.token != address(0) || c.isShare) {
                revert InvalidCollateral();
            }
            if (remoteCollateralId[c.chainId][c.remoteToken] != 0) revert InvalidCollateral();
        } else {
            if (c.token == address(0) || _localListed[c.token]) revert InvalidCollateral();
            // Shares are valued through their pool's exchange rate and plain tokens unit for unit, both at
            // `decimals`: a wrong kind or decimals would misprice every deposit, so both are checked.
            address units = c.isShare ? _poolAsset(c.token) : c.token;
            if (IERC20Decimals(units).decimals() != c.decimals) revert InvalidCollateral();
            _localListed[c.token] = true;
        }
        id = _collaterals.length;
        _collaterals.push(c);
        if (c.isRemote) remoteCollateralId[c.chainId][c.remoteToken] = id + 1;
        emit CollateralAdded(id, c);
    }

    function setCollateralParams(uint256 id, uint16 ltvBps, uint16 ltBps, uint16 bonusBps, uint256 cap, bool enabled)
        external
        onlyOwner
    {
        _validateParams(ltvBps, ltBps, bonusBps);
        CollateralConfig storage c = _collateral(id);
        c.ltvBps = ltvBps;
        c.ltBps = ltBps;
        c.bonusBps = bonusBps;
        c.cap = cap;
        c.enabled = enabled;
        emit CollateralParamsSet(id, ltvBps, ltBps, bonusBps, cap, enabled);
    }

    function addMarket(PToken pool, bytes32 priceKey) external onlyOwner returns (uint256 marketId) {
        if (_markets.length >= MAX_MARKETS || address(pool) == address(0)) revert InvalidParams();
        for (uint256 i = 0; i < _markets.length; i++) {
            if (_markets[i].pool == pool) revert InvalidMarket();
        }
        marketId = _markets.length;
        _markets.push(Market(pool, priceKey, IERC20Decimals(pool.asset()).decimals(), true));
        emit MarketAdded(marketId, address(pool), priceKey);
    }

    /// @notice Sets the Wormhole adapter once. It cannot be rotated: a new adapter would orphan messages
    ///         in flight and reset the DEPOSIT replay guard that lives in the adapter.
    function setAdapter(address adapter_) external onlyOwner {
        if (adapter != address(0)) revert AdapterAlreadySet();
        if (adapter_ == address(0)) revert InvalidParams();
        adapter = adapter_;
        emit AdapterSet(adapter_);
    }

    /// @notice Blocks new borrows. Collateral top-ups, repay, withdraw and liquidation stay open, so users
    ///         can always reduce risk or exit while the protocol is paused.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setLiquidationFee(uint16 bps) external onlyOwner {
        if (bps > MAX_LIQUIDATION_FEE_BPS) revert InvalidParams();
        liquidationFeeBps = bps;
        emit LiquidationFeeSet(bps);
    }

    function _validateParams(uint16 ltvBps, uint16 ltBps, uint16 bonusBps) internal pure {
        // Liquidation must stay profitable before the position becomes insolvent: lt × (1 + bonus) ≤ 100%.
        if (ltvBps > ltBps || ltBps > 9_500 || bonusBps > 2_000 || uint256(ltBps) * (BPS + bonusBps) > BPS * BPS) {
            revert InvalidParams();
        }
    }

    // =========================================================================
    // User actions
    // =========================================================================

    function setOperator(address operator, bool approved) external {
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
    }

    /// @notice Posts hub collateral held by the caller (pToken shares or plain token units).
    function depositCollateral(uint256 id, uint256 shares) external nonReentrant {
        _depositLocal(msg.sender, id, shares);
    }

    /// @notice Posts the caller's collateral tokens for `account` (e.g. LeverageManager).
    /// @dev Operator-only: unsolicited collateral could add an oracle dependency to someone else's account.
    function depositCollateralFor(address account, uint256 id, uint256 shares)
        external
        nonReentrant
        onlyOperatorOf(account)
    {
        _depositLocal(account, id, shares);
    }

    function withdrawCollateral(uint256 id, uint256 shares, address to, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
    {
        uint256 spent = _pushPrices(priceUpdate);
        _withdrawLocal(msg.sender, id, shares, to);
        _refund(spent);
    }

    function withdrawCollateralFor(
        address account,
        uint256 id,
        uint256 shares,
        address to,
        bytes[] calldata priceUpdate
    ) external payable nonReentrant onlyOperatorOf(account) {
        uint256 spent = _pushPrices(priceUpdate);
        _withdrawLocal(account, id, shares, to);
        _refund(spent);
    }

    /// @notice Releases collateral held on a spoke to `recipient` there, via a Wormhole RELEASE message.
    /// @dev The hub balance is debited before the message is sent, so the spoke can never release
    ///      more than the hub has accounted for. msg.value must cover price updates + Wormhole fee.
    function withdrawRemote(uint256 id, uint256 amount, bytes32 recipient, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
    {
        CollateralConfig storage c = _collateral(id);
        if (!c.isRemote) revert InvalidCollateral();
        _requireRecipient(recipient);
        if (amount == 0) revert ZeroAmount();
        uint256 spent = _pushPrices(priceUpdate);
        _debit(msg.sender, id, amount);
        _requireWithinLimit(msg.sender, 0, 0);
        uint256 fee = IReleaseSender(adapter).messageFee();
        // Checked before the message is paid for: BTC collateral is this contract's native balance on Mezo.
        if (msg.value < spent + fee) revert InsufficientValue();
        uint64 sequence = IReleaseSender(adapter).sendRelease{value: fee}(c.chainId, c.remoteToken, recipient, amount);
        emit RemoteWithdrawRequested(msg.sender, id, amount, recipient, sequence);
        _refund(spent + fee);
    }

    function borrow(uint256 marketId, uint256 amount, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        uint256 spent = _pushPrices(priceUpdate);
        _borrow(msg.sender, marketId, amount, msg.sender);
        _refund(spent);
    }

    function borrowFor(
        address account,
        uint256 marketId,
        uint256 amount,
        address receiver,
        bytes[] calldata priceUpdate
    ) external payable nonReentrant whenNotPaused onlyOperatorOf(account) {
        uint256 spent = _pushPrices(priceUpdate);
        _borrow(account, marketId, amount, receiver);
        _refund(spent);
    }

    /// @notice Repays debt of `onBehalfOf` from the caller's tokens. `type(uint256).max` repays everything.
    function repay(uint256 marketId, uint256 amount, address onBehalfOf)
        external
        nonReentrant
        returns (uint256 applied)
    {
        applied = _repay(onBehalfOf, marketId, amount, msg.sender);
    }

    /// @notice Repays `account`'s debt in a market with its posted shares of that same pool, like Aave's
    ///         repayWithATokens: the pool burns the shares and clears the debt they are worth, so no cash moves
    ///         and it works at any utilisation. Debt falls by exactly the value the collateral loses, and that
    ///         collateral counts at LTV and LT below 100%, so the position can only improve: no price is needed.
    /// @param amount Debt to repay at most; `type(uint256).max` repays as much as the posted shares cover.
    /// @dev The account or its operator only. Leaving debt with no collateral at all would create bad debt
    ///      that only a final liquidation writes off, so that case reverts.
    function repayWithCollateral(address account, uint256 marketId, uint256 collateralId, uint256 amount)
        external
        nonReentrant
        onlyOperatorOf(account)
        returns (uint256 repaid, uint256 sharesBurned)
    {
        Market storage m = _market(marketId);
        CollateralConfig storage c = _collateral(collateralId);
        if (c.isRemote || !c.isShare || c.token != address(m.pool)) revert InvalidCollateral();
        if (amount == 0) revert ZeroAmount();
        uint256 posted = collateralBalance[account][collateralId];
        if (posted == 0) revert InsufficientBalance();
        m.pool.accrueInterest();
        if (m.pool.borrowBalanceStored(account) == 0) revert NothingToRepay();
        (repaid, sharesBurned) = m.pool.repayWithShares(account, posted, amount);
        _debit(account, collateralId, sharesBurned);
        if (!_hasCollateral(account) && _hasDebt(account)) revert WouldLeaveBadDebt();
        emit RepaidWithCollateral(account, marketId, collateralId, repaid, sharesBurned);
    }

    /// @notice Liquidates an account with health factor < 1.
    /// @param repayAmount Debt to repay, capped by the 50% close factor and by available collateral.
    /// @param minSeize Minimum collateral units the liquidator receives, after the protocol fee (slippage guard).
    /// @param localReceiver Receives seized hub collateral (pTokens or plain tokens).
    /// @param remoteReceiver Receives seized tokens on the spoke (remote collateral).
    /// @return seized Collateral units the liquidator receives.
    function liquidate(
        address account,
        uint256 marketId,
        uint256 repayAmount,
        uint256 collateralId,
        uint256 minSeize,
        address localReceiver,
        bytes32 remoteReceiver,
        bytes[] calldata priceUpdate
    ) external payable nonReentrant returns (uint256 seized) {
        uint256 spent = _pushPrices(priceUpdate);
        _accrueAll();
        Market storage m = _market(marketId);
        CollateralConfig storage c = _collateral(collateralId);
        if (collateralBalance[account][collateralId] == 0) revert InsufficientBalance();
        if (c.isRemote) _requireRecipient(remoteReceiver);
        {
            // Strict on every held collateral: an oracle outage must not make healthy positions liquidatable.
            (,,, uint256 debtValue, uint256 hf) = _position(account, PriceMode.Strict);
            if (debtValue == 0 || hf >= WAD) revert PositionHealthy();
        }

        uint256 owed = m.pool.borrowBalanceStored(account);
        uint256 repaid = Math.min(repayAmount, owed * CLOSE_FACTOR_BPS / BPS);
        if (repaid == 0) revert ZeroAmount();
        uint256 taken;
        (taken, repaid) = _seizeAmount(account, m, c, collateralId, repaid);
        // `taken` is the repaid value plus the bonus; the protocol keeps liquidationFeeBps of the bonus.
        uint256 protocolFee = taken * c.bonusBps / (BPS + c.bonusBps) * liquidationFeeBps / BPS;
        seized = taken - protocolFee;
        if (seized < minSeize || seized == 0) revert SlippageExceeded();

        _debit(account, collateralId, taken);
        if (protocolFee > 0) {
            // Stays in custody as the treasury's collateral: no transfer or spoke message is needed.
            collateralBalance[treasury][collateralId] += protocolFee;
            totalCollateral[collateralId] += protocolFee;
            emit LiquidationFeeTaken(account, collateralId, protocolFee, treasury);
        }
        IERC20(m.pool.asset()).safeTransferFrom(msg.sender, address(m.pool), repaid);
        m.pool.notifyRepay(account, repaid);

        uint256 messageFee;
        if (c.isRemote) {
            messageFee = IReleaseSender(adapter).messageFee();
            if (msg.value < spent + messageFee) revert InsufficientValue();
            IReleaseSender(adapter).sendRelease{value: messageFee}(c.chainId, c.remoteToken, remoteReceiver, seized);
        } else {
            IERC20(c.token).safeTransfer(localReceiver, seized);
        }
        emit Liquidated(account, msg.sender, marketId, collateralId, repaid, seized);
        // Nothing left to seize: whatever is still owed can never be repaid by liquidation.
        if (!_hasCollateral(account)) _writeOffDebt(account);
        _refund(spent + messageFee);
    }

    /// @notice Credits spoke collateral after the adapter verified a Wormhole DEPOSIT message.
    /// @dev Not pausable and ignores `enabled`/`cap`: the tokens are already locked on the spoke
    ///      (which enforces its own caps), so refusing the credit would strand user funds.
    function creditRemote(address account, uint256 id, uint256 amount) external onlyAdapter {
        CollateralConfig storage c = _collateral(id);
        if (!c.isRemote) revert InvalidCollateral();
        collateralBalance[account][id] += amount;
        totalCollateral[id] += amount;
        emit RemoteCredited(account, id, amount);
    }

    // =========================================================================
    // Views
    // =========================================================================

    function getRiskSnapshot(address account) external view returns (RiskSnapshot memory s) {
        (s.collateralValue, s.adjustedCollateral, s.borrowLimit, s.debtValue, s.healthFactor) =
            _position(account, PriceMode.View);
    }

    function collaterals(uint256 id) external view returns (CollateralConfig memory) {
        return _collateral(id);
    }

    function markets(uint256 marketId) external view returns (Market memory) {
        return _market(marketId);
    }

    function collateralCount() external view returns (uint256) {
        return _collaterals.length;
    }

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    /// @notice USD value (WAD) of `account`'s balance in collateral `id`, at last known prices.
    function collateralValue(address account, uint256 id) external view returns (uint256) {
        return _valueOf(_collaterals[id], collateralBalance[account][id], PriceMode.View);
    }

    // =========================================================================
    // Internals
    // =========================================================================

    function _collateral(uint256 id) internal view returns (CollateralConfig storage) {
        if (id >= _collaterals.length) revert InvalidCollateral();
        return _collaterals[id];
    }

    function _market(uint256 marketId) internal view returns (Market storage) {
        if (marketId >= _markets.length) revert InvalidMarket();
        return _markets[marketId];
    }

    function _depositLocal(address account, uint256 id, uint256 shares) internal {
        CollateralConfig storage c = _collateral(id);
        if (c.isRemote || !c.enabled) revert InvalidCollateral();
        if (shares == 0) revert ZeroAmount();
        if (totalCollateral[id] + shares > c.cap) revert CapExceeded();
        collateralBalance[account][id] += shares;
        totalCollateral[id] += shares;
        IERC20(c.token).safeTransferFrom(msg.sender, address(this), shares);
        emit CollateralDeposited(account, id, shares, msg.sender);
    }

    function _withdrawLocal(address account, uint256 id, uint256 shares, address to) internal {
        CollateralConfig storage c = _collateral(id);
        if (c.isRemote) revert InvalidCollateral();
        if (shares == 0) revert ZeroAmount();
        _debit(account, id, shares);
        _requireWithinLimit(account, 0, 0);
        IERC20(c.token).safeTransfer(to, shares);
        emit CollateralWithdrawn(account, id, shares, to);
    }

    function _debit(address account, uint256 id, uint256 amount) internal {
        uint256 balance = collateralBalance[account][id];
        if (amount > balance) revert InsufficientBalance();
        collateralBalance[account][id] = balance - amount;
        totalCollateral[id] -= amount;
    }

    function _borrow(address account, uint256 marketId, uint256 amount, address receiver) internal {
        Market storage m = _market(marketId);
        if (!m.enabled) revert InvalidMarket();
        if (amount == 0) revert ZeroAmount();
        // Check the post-borrow position before any tokens move.
        _requireWithinLimit(account, marketId, amount);
        m.pool.borrow(account, amount, receiver);
        emit Borrowed(account, marketId, amount, receiver);
    }

    function _repay(address account, uint256 marketId, uint256 amount, address payer)
        internal
        returns (uint256 applied)
    {
        Market storage m = _market(marketId);
        m.pool.accrueInterest();
        uint256 owed = m.pool.borrowBalanceStored(account);
        if (owed == 0) revert NothingToRepay();
        applied = Math.min(amount, owed);
        IERC20(m.pool.asset()).safeTransferFrom(payer, address(m.pool), applied);
        m.pool.notifyRepay(account, applied);
        emit Repaid(account, marketId, applied, payer);
    }

    /// @dev Reverts unless Σ value × LTV ≥ debt (+ `extraAmount` of market `extraMarket`).
    ///      Debt is priced strictly. Collateral whose price is unavailable counts as zero, so an outage
    ///      on one asset never blocks actions that the remaining collateral supports. With no debt
    ///      nothing is at risk and no price is needed.
    function _requireWithinLimit(address account, uint256 extraMarket, uint256 extraAmount) internal {
        _accrueAll();
        uint256 debtValue = _debtValue(account, true);
        if (extraAmount > 0) {
            Market storage m = _markets[extraMarket];
            debtValue += _usdUp(extraAmount, oracle.getPrice(m.priceKey), m.decimals);
        }
        // Debt rounds up, so this is zero only when nothing is owed or borrowed.
        if (debtValue == 0) return;
        (,, uint256 limit) = _collateralTotals(account, PriceMode.Conservative);
        if (debtValue > limit) revert InsufficientCollateral();
    }

    function _hasCollateral(address account) internal view returns (bool) {
        for (uint256 id = 0; id < _collaterals.length; id++) {
            if (collateralBalance[account][id] != 0) return true;
        }
        return false;
    }

    function _hasDebt(address account) internal view returns (bool) {
        for (uint256 i = 0; i < _markets.length; i++) {
            if (_markets[i].pool.borrowBalanceStored(account) != 0) return true;
        }
        return false;
    }

    /// Asset of a listed market pool; reverts for any other address.
    function _poolAsset(address pool) internal view returns (address) {
        for (uint256 i = 0; i < _markets.length; i++) {
            if (address(_markets[i].pool) == pool) return _markets[i].pool.asset();
        }
        revert InvalidCollateral();
    }

    function _writeOffDebt(address account) internal {
        for (uint256 i = 0; i < _markets.length; i++) {
            uint256 amount = _markets[i].pool.writeOff(account);
            if (amount > 0) emit BadDebtWrittenOff(account, i, amount);
        }
    }

    function _requireRecipient(bytes32 recipient) internal pure {
        // The spoke decodes recipients as left-padded EVM addresses; anything else could never be released.
        if (recipient == bytes32(0) || !Payload.isAddress(recipient)) revert InvalidRecipient();
    }

    function _accrueAll() internal {
        for (uint256 i = 0; i < _markets.length; i++) {
            _markets[i].pool.accrueInterest();
        }
    }

    /// @dev Full position. `View` uses last known prices and pending interest; otherwise prices follow
    ///      `mode` for collateral and are strict for debt (call `_accrueAll` first).
    function _position(address account, PriceMode mode)
        internal
        view
        returns (uint256 value, uint256 adjusted, uint256 limit, uint256 debtValue, uint256 hf)
    {
        (value, adjusted, limit) = _collateralTotals(account, mode);
        debtValue = _debtValue(account, mode != PriceMode.View);
        hf = debtValue == 0 ? type(uint256).max : adjusted * WAD / debtValue;
    }

    function _collateralTotals(address account, PriceMode mode)
        internal
        view
        returns (uint256 value, uint256 adjusted, uint256 limit)
    {
        for (uint256 id = 0; id < _collaterals.length; id++) {
            uint256 balance = collateralBalance[account][id];
            if (balance == 0) continue;
            CollateralConfig storage c = _collaterals[id];
            uint256 v = _valueOf(c, balance, mode);
            value += v;
            adjusted += v * c.ltBps / BPS;
            // Disabled collateral keeps backing existing debt (health) but supports no new borrowing.
            if (c.enabled) limit += v * c.ltvBps / BPS;
        }
    }

    /// @param strict Stored debt at fresh prices (mutating paths, after accrual) or pending debt at
    ///        last known prices (views).
    function _debtValue(address account, bool strict) internal view returns (uint256 debtValue) {
        for (uint256 i = 0; i < _markets.length; i++) {
            Market storage m = _markets[i];
            uint256 debt = strict ? m.pool.borrowBalanceStored(account) : m.pool.borrowBalanceView(account);
            if (debt == 0) continue;
            debtValue += _usdUp(debt, _priceFor(m.priceKey, strict ? PriceMode.Strict : PriceMode.View), m.decimals);
        }
    }

    function _valueOf(CollateralConfig storage c, uint256 balance, PriceMode mode) internal view returns (uint256) {
        if (balance == 0) return 0;
        uint256 units = c.isShare ? PToken(c.token).convertToAssets(balance) : balance;
        return _usd(units, _priceFor(c.priceKey, mode), c.decimals);
    }

    function _seizeAmount(
        address account,
        Market storage m,
        CollateralConfig storage c,
        uint256 collateralId,
        uint256 repaid
    ) internal view returns (uint256 seized, uint256 actualRepaid) {
        uint256 repayValue = _usd(repaid, oracle.getPrice(m.priceKey), m.decimals);
        uint256 seizeValue = repayValue * (BPS + c.bonusBps) / BPS;
        uint256 price = oracle.getPrice(c.priceKey);
        uint256 seizeUnits = seizeValue * 10 ** c.decimals / price;

        uint256 balance = collateralBalance[account][collateralId];
        uint256 balanceUnits = c.isShare ? PToken(c.token).convertToAssets(balance) : balance;
        if (seizeUnits >= balanceUnits) {
            // Not enough collateral: take all of it and scale the repayment down proportionally.
            return (balance, Math.mulDiv(repaid, balanceUnits, seizeUnits, Math.Rounding.Ceil));
        }
        seized = c.isShare ? PToken(c.token).convertToShares(seizeUnits) : seizeUnits;
        actualRepaid = repaid;
    }

    function _priceFor(bytes32 key, PriceMode mode) internal view returns (uint256 price) {
        if (mode == PriceMode.Strict) return oracle.getPrice(key);
        if (mode == PriceMode.Conservative) {
            (bool ok, uint256 p) = oracle.tryGetPrice(key);
            return ok ? p : 0;
        }
        (price,) = oracle.getPriceUnsafe(key);
    }

    function _usd(uint256 amount, uint256 priceWad, uint8 decimals) internal pure returns (uint256) {
        return Math.mulDiv(amount, priceWad, 10 ** decimals);
    }

    /// Debt is valued rounding up: a few wei of a token worth under $1 must never count as no debt at all.
    function _usdUp(uint256 amount, uint256 priceWad, uint8 decimals) internal pure returns (uint256) {
        return Math.mulDiv(amount, priceWad, 10 ** decimals, Math.Rounding.Ceil);
    }

    function _pushPrices(bytes[] calldata updates) internal returns (uint256 fee) {
        if (updates.length == 0) return 0;
        fee = oracle.updateFee(updates);
        if (msg.value < fee) revert InsufficientValue();
        oracle.updatePrices{value: fee}(updates);
    }

    /// @dev Returns `msg.value - spent` to the caller.
    function _refund(uint256 spent) internal {
        if (msg.value < spent) revert InsufficientValue();
        uint256 refund = msg.value - spent;
        if (refund == 0) return;
        (bool ok,) = msg.sender.call{value: refund}("");
        if (!ok) revert RefundFailed();
    }
}

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}
