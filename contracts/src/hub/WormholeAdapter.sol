// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWormhole} from "../interfaces/IWormhole.sol";
import {Payload} from "../libraries/Payload.sol";
import {VaultManager} from "./VaultManager.sol";

/// @title WormholeAdapter
/// @notice The hub's only Wormhole endpoint. Verifies DEPOSIT messages from registered spoke
///         gateways and credits collateral in VaultManager; publishes RELEASE messages for
///         remote withdrawals and liquidations.
/// @dev Anyone may relay a VAA: safety comes from guardian signatures, the emitter registry
///      and the replay guard, not from who submits it.
contract WormholeAdapter is Ownable2Step, ReentrancyGuard {
    IWormhole public immutable wormhole;
    VaultManager public immutable vaultManager;
    uint8 public immutable consistencyLevel;

    /// @notice Registered SpokeGateway (universal address) per Wormhole chain id.
    mapping(uint16 chainId => bytes32 emitter) public spokeEmitter;
    mapping(bytes32 vaaHash => bool) public isConsumed;
    uint64 public outboundNonce;

    event SpokeSet(uint16 indexed chainId, bytes32 emitter);
    event DepositReceived(
        bytes32 indexed vaaHash, uint16 indexed chainId, address indexed account, bytes32 token, uint256 amount
    );
    event ReleaseSent(
        uint64 indexed sequence, uint16 indexed chainId, bytes32 recipient, bytes32 token, uint256 amount
    );

    error InvalidVaa(string reason);
    error UnknownEmitter();
    error AlreadyConsumed();
    error WrongMessageType();
    error UnknownCollateral();
    error NotVaultManager();

    constructor(IWormhole wormhole_, VaultManager vaultManager_, uint8 consistencyLevel_, address owner_)
        Ownable(owner_)
    {
        wormhole = wormhole_;
        vaultManager = vaultManager_;
        consistencyLevel = consistencyLevel_;
    }

    function setSpoke(uint16 chainId, bytes32 emitter) external onlyOwner {
        spokeEmitter[chainId] = emitter;
        emit SpokeSet(chainId, emitter);
    }

    function messageFee() external view returns (uint256) {
        return wormhole.messageFee();
    }

    /// @notice Verifies a spoke DEPOSIT VAA and credits the depositor's hub account.
    function receiveMessage(bytes calldata encodedVaa) external nonReentrant returns (bytes32 hash) {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(encodedVaa);
        if (!valid) revert InvalidVaa(reason);
        bytes32 expected = spokeEmitter[vm.emitterChainId];
        if (expected == bytes32(0) || expected != vm.emitterAddress) revert UnknownEmitter();
        hash = vm.hash;
        if (isConsumed[hash]) revert AlreadyConsumed();
        isConsumed[hash] = true;

        Payload.Message memory m = Payload.decode(vm.payload);
        if (m.msgType != Payload.DEPOSIT) revert WrongMessageType();
        uint256 idPlusOne = vaultManager.remoteCollateralId(vm.emitterChainId, m.token);
        if (idPlusOne == 0) revert UnknownCollateral();
        address account = Payload.toAddress(m.account);

        vaultManager.creditRemote(account, idPlusOne - 1, m.amount);
        emit DepositReceived(hash, vm.emitterChainId, account, m.token, m.amount);
    }

    /// @notice Publishes a RELEASE for `recipient` on the spoke. Only VaultManager, after debiting the hub balance.
    function sendRelease(uint16 chainId, bytes32 token, bytes32 recipient, uint256 amount)
        external
        payable
        returns (uint64 sequence)
    {
        if (msg.sender != address(vaultManager)) revert NotVaultManager();
        if (spokeEmitter[chainId] == bytes32(0)) revert UnknownEmitter();
        bytes memory payload =
            Payload.encode(Payload.Message(Payload.RELEASE, ++outboundNonce, recipient, token, amount));
        sequence = wormhole.publishMessage{value: msg.value}(0, payload, consistencyLevel);
        emit ReleaseSent(sequence, chainId, recipient, token, amount);
    }
}
