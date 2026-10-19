// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWormhole} from "../interfaces/IWormhole.sol";
import {Payload} from "../libraries/Payload.sol";

/// @title SpokeGateway
/// @notice Collateral vault on an external chain (Base / Ethereum). Locks deposits and tells the
///         Mezo hub via Wormhole; releases tokens only on a verified RELEASE from the hub adapter.
/// @dev The depositor's address is their hub account. Principal never leaves this chain.
contract SpokeGateway is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TokenConfig {
        bool allowed;
        uint256 cap;
    }

    IWormhole public immutable wormhole;
    uint16 public immutable hubChainId;
    uint8 public immutable consistencyLevel;
    /// @notice Wormhole chain id of this spoke (read from Wormhole Core at deployment).
    uint16 public immutable localChainId;

    bytes32 public hubEmitter;
    mapping(address token => TokenConfig) public tokens;
    mapping(address token => uint256) public locked;
    mapping(bytes32 vaaHash => bool) public isConsumed;
    /// Releases whose transfer failed (e.g. a blacklisted recipient or a paused token), held for the recipient.
    mapping(address recipient => mapping(address token => uint256)) public claimable;
    uint64 public outboundNonce;

    event HubEmitterSet(bytes32 emitter);
    event TokenSet(address indexed token, bool allowed, uint256 cap);
    event Deposited(uint64 indexed sequence, address indexed account, address indexed token, uint256 amount);
    event Released(bytes32 indexed vaaHash, address indexed recipient, address indexed token, uint256 amount);
    event ReleaseDeferred(bytes32 indexed vaaHash, address indexed recipient, address indexed token, uint256 amount);
    event Claimed(address indexed recipient, address indexed token, address to, uint256 amount);

    error TokenNotAllowed();
    error CapExceeded();
    error ZeroAmount();
    error WrongFee();
    error HubNotSet();
    error InvalidVaa(string reason);
    error UnknownEmitter();
    error AlreadyConsumed();
    error WrongMessageType();
    error InsufficientLocked();
    error WrongTarget();

    constructor(IWormhole wormhole_, uint16 hubChainId_, uint8 consistencyLevel_, address owner_) Ownable(owner_) {
        wormhole = wormhole_;
        hubChainId = hubChainId_;
        consistencyLevel = consistencyLevel_;
        localChainId = wormhole_.chainId();
    }

    function setHubEmitter(bytes32 emitter) external onlyOwner {
        hubEmitter = emitter;
        emit HubEmitterSet(emitter);
    }

    function setToken(address token, bool allowed, uint256 cap) external onlyOwner {
        tokens[token] = TokenConfig(allowed, cap);
        emit TokenSet(token, allowed, cap);
    }

    /// @notice Blocks new deposits only; releases keep working so users can always exit.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function messageFee() external view returns (uint256) {
        return wormhole.messageFee();
    }

    /// @notice Locks `amount` of `token` and publishes a DEPOSIT for the caller's hub account.
    /// @dev msg.value must equal the Wormhole message fee. Credits the amount actually received.
    function deposit(address token, uint256 amount)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint64 sequence)
    {
        TokenConfig memory cfg = tokens[token];
        if (!cfg.allowed) revert TokenNotAllowed();
        if (amount == 0) revert ZeroAmount();
        if (hubEmitter == bytes32(0)) revert HubNotSet();
        if (msg.value != wormhole.messageFee()) revert WrongFee();

        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        locked[token] += received;
        if (locked[token] > cfg.cap) revert CapExceeded();

        // Addressed to the registered hub adapter only, so the VAA can never credit a different adapter.
        bytes memory payload = Payload.encode(
            Payload.Message(
                Payload.DEPOSIT,
                ++outboundNonce,
                hubChainId,
                hubEmitter,
                Payload.toBytes32(msg.sender),
                Payload.toBytes32(token),
                received
            )
        );
        sequence = wormhole.publishMessage{value: msg.value}(0, payload, consistencyLevel);
        emit Deposited(sequence, msg.sender, token, received);
    }

    /// @notice Executes a RELEASE published by the hub adapter. Anyone may relay it.
    function receiveMessage(bytes calldata encodedVaa) external nonReentrant returns (bytes32 hash) {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole.parseAndVerifyVM(encodedVaa);
        if (!valid) revert InvalidVaa(reason);
        if (vm.emitterChainId != hubChainId || hubEmitter == bytes32(0) || vm.emitterAddress != hubEmitter) {
            revert UnknownEmitter();
        }
        hash = vm.hash;
        if (isConsumed[hash]) revert AlreadyConsumed();
        isConsumed[hash] = true;

        Payload.Message memory m = Payload.decode(vm.payload);
        if (m.msgType != Payload.RELEASE) revert WrongMessageType();
        // A RELEASE names exactly one gateway: never execute one addressed to another chain or deployment.
        if (m.targetChain != localChainId || m.target != Payload.toBytes32(address(this))) revert WrongTarget();
        address token = Payload.toAddress(m.token);
        address recipient = Payload.toAddress(m.account);
        if (m.amount > locked[token]) revert InsufficientLocked();
        locked[token] -= m.amount;
        // The hub has already debited the account, so a transfer that fails must not strand the tokens: they
        // become claimable by the recipient, who can send them to another address.
        if (_tryTransfer(token, recipient, m.amount)) {
            emit Released(hash, recipient, token, m.amount);
        } else {
            claimable[recipient][token] += m.amount;
            emit ReleaseDeferred(hash, recipient, token, m.amount);
        }
    }

    /// @notice Sends the caller's deferred releases of `token` to `to`.
    function claim(address token, address to) external nonReentrant {
        uint256 amount = claimable[msg.sender][token];
        if (amount == 0) revert ZeroAmount();
        claimable[msg.sender][token] = 0;
        IERC20(token).safeTransfer(to, amount);
        emit Claimed(msg.sender, token, to, amount);
    }

    /// SafeERC20's success rule (no return data from a contract, or `true`) without reverting.
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return token.code.length > 0;
        return ret.length == 32 && abi.decode(ret, (uint256)) == 1;
    }
}
