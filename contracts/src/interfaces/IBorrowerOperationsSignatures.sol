// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Mezo's MUSD trove operations authorised by the borrower's EIP-712 signature, so a contract can run them.
/// @dev Signatures are checked with ECDSA only, so the borrower must be an EOA key (no ERC-1271 smart accounts). Each
///      signature names the amounts, the borrower and the recipient, but not the caller.
interface IBorrowerOperationsSignatures {
    /// @notice Opens the borrower's trove with `msg.value` of BTC and mints `debtAmount` MUSD to `recipient`.
    function openTroveWithSignature(
        uint256 debtAmount,
        address upperHint,
        address lowerHint,
        address borrower,
        address recipient,
        bytes calldata signature,
        uint256 deadline
    ) external payable;

    /// @notice Repays the borrower's trove with MUSD burned from the caller (no allowance needed).
    function repayMUSDWithSignature(
        uint256 amount,
        address upperHint,
        address lowerHint,
        address borrower,
        bytes calldata signature,
        uint256 deadline
    ) external;

    /// @notice Closes the borrower's trove with MUSD burned from the caller and sends its BTC to `recipient`.
    function closeTroveWithSignature(address borrower, address recipient, bytes calldata signature, uint256 deadline)
        external;
}
