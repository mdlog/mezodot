// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VaultManager} from "./VaultManager.sol";
import {WormholeAdapter} from "./WormholeAdapter.sol";

/// @title KeeperGateway
/// @notice Permissionless, incentive-driven surface for autonomous agents: liquidations (paid by
///         the liquidation bonus) and relaying cross-chain messages. Tracks unique keepers for the
///         "Agent Participation" KPI.
contract KeeperGateway is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct KeeperStats {
        uint64 liquidations;
        uint64 relays;
    }

    VaultManager public immutable vaultManager;
    WormholeAdapter public immutable adapter;

    mapping(address keeper => KeeperStats) public stats;
    mapping(address keeper => bool) public isKeeper;
    uint256 public keeperCount;

    event LiquidationTriggered(
        address indexed keeper,
        address indexed account,
        uint256 marketId,
        uint256 collateralId,
        uint256 repaid,
        uint256 seized
    );
    event MessageRelayed(address indexed keeper, bytes32 indexed vaaHash);
    event KeeperRegistered(address indexed keeper);

    error RefundFailed();

    constructor(VaultManager vaultManager_, WormholeAdapter adapter_) {
        vaultManager = vaultManager_;
        adapter = adapter_;
    }

    /// @notice Liquidates `account`, paying the repayment from the caller's tokens.
    /// @param remoteReceiver Spoke address for remote collateral; defaults to the caller.
    /// @dev Unused repayment tokens and BTC are returned to the caller.
    function triggerLiquidation(
        address account,
        uint256 marketId,
        uint256 repayAmount,
        uint256 collateralId,
        uint256 minSeize,
        bytes32 remoteReceiver,
        bytes[] calldata priceUpdate
    ) external payable nonReentrant returns (uint256 seized) {
        IERC20 asset = IERC20(vaultManager.markets(marketId).pool.asset());
        uint256 before = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), repayAmount);
        asset.forceApprove(address(vaultManager), repayAmount);
        if (remoteReceiver == bytes32(0)) remoteReceiver = bytes32(uint256(uint160(msg.sender)));

        seized = vaultManager.liquidate{value: msg.value}(
            account, marketId, repayAmount, collateralId, minSeize, msg.sender, remoteReceiver, priceUpdate
        );
        asset.forceApprove(address(vaultManager), 0);

        uint256 unused = asset.balanceOf(address(this)) - before;
        if (unused > 0) asset.safeTransfer(msg.sender, unused);
        // The gateway never keeps BTC: refund all of it, including BTC sent here by mistake (an ERC-20 transfer
        // on Mezo's BTC precompile moves the native balance without calling receive(), so it cannot be refused).
        uint256 btcRefund = address(this).balance;
        if (btcRefund > 0) {
            (bool ok,) = msg.sender.call{value: btcRefund}("");
            if (!ok) revert RefundFailed();
        }

        _record(msg.sender).liquidations++;
        emit LiquidationTriggered(msg.sender, account, marketId, collateralId, repayAmount - unused, seized);
    }

    /// @notice Relays a spoke DEPOSIT VAA to the hub adapter.
    function relayMessage(bytes calldata vaa) external nonReentrant returns (bytes32 hash) {
        hash = adapter.receiveMessage(vaa);
        _record(msg.sender).relays++;
        emit MessageRelayed(msg.sender, hash);
    }

    function getRiskSnapshot(address account) external view returns (VaultManager.RiskSnapshot memory) {
        return vaultManager.getRiskSnapshot(account);
    }

    function _record(address keeper) internal returns (KeeperStats storage) {
        if (!isKeeper[keeper]) {
            isKeeper[keeper] = true;
            keeperCount++;
            emit KeeperRegistered(keeper);
        }
        return stats[keeper];
    }

    /// @dev Receives BTC refunds from VaultManager during liquidation; whatever is held goes to the next keeper.
    receive() external payable {}
}
