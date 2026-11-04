// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockERC20} from "./MockERC20.sol";

/// @notice The money movements of Mezo's BorrowerOperationsSignatures: MUSD minted to the signed recipient on open,
///         burned from the caller without an allowance on repay and close, BTC sent to the signed recipient on close.
///         Signatures are not checked here (test/fork/ForkTrove.t.sol runs the real contract with real signatures); an
///         empty one stands for an invalid one.
contract MockBorrowerOperationsSignatures {
    uint256 public constant GAS_COMPENSATION = 200e18;
    uint256 public constant MIN_NET_DEBT = 1_800e18;

    MockERC20 public immutable musd;
    mapping(address borrower => uint256) public debt;
    mapping(address borrower => uint256) public coll;

    constructor(MockERC20 musd_) {
        musd = musd_;
    }

    function openTroveWithSignature(
        uint256 debtAmount,
        address,
        address,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external payable {
        _check(signature, deadline);
        require(debt[borrower] == 0, "trove is active");
        require(debtAmount >= MIN_NET_DEBT, "min net debt");
        debt[borrower] = debtAmount + GAS_COMPENSATION;
        coll[borrower] = msg.value;
        musd.mint(recipient, debtAmount);
    }

    function repayMUSDWithSignature(
        uint256 amount,
        address,
        address,
        address borrower,
        bytes calldata signature,
        uint256 deadline
    ) external {
        _check(signature, deadline);
        require(debt[borrower] - GAS_COMPENSATION - amount >= MIN_NET_DEBT, "min net debt");
        musd.burn(msg.sender, amount);
        debt[borrower] -= amount;
    }

    function closeTroveWithSignature(address borrower, address recipient, bytes calldata signature, uint256 deadline)
        external
    {
        _check(signature, deadline);
        require(debt[borrower] > 0, "trove is not active");
        musd.burn(msg.sender, debt[borrower] - GAS_COMPENSATION);
        uint256 amount = coll[borrower];
        delete debt[borrower];
        delete coll[borrower];
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "send failed");
    }

    function _check(bytes calldata signature, uint256 deadline) internal view {
        require(signature.length > 0, "invalid signature");
        require(block.timestamp <= deadline, "signature expired");
    }
}
