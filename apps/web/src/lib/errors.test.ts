import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult } from 'viem';
import { PRICE_KEYS, oracleRouterAbi, swapLeverageManagerAbi, vaultManagerAbi } from '@mezodot/sdk';
import { explainError } from './errors';

/** A revert raised by OracleRouter inside a VaultManager call, as viem reports it to the app. */
const bubbled = (errorName: 'PriceUnavailable' | 'PriceDiverged', key: `0x${string}`) =>
  new ContractFunctionRevertedError({
    abi: vaultManagerAbi,
    functionName: 'borrow',
    data: encodeErrorResult({ abi: oracleRouterAbi, errorName, args: [key] }),
  });

describe('explainError', () => {
  it('names the asset when an oracle error bubbles up through VaultManager', () => {
    expect(explainError(bubbled('PriceUnavailable', PRICE_KEYS.ETH))).toBe('ETH price is unavailable right now (stale or too uncertain) — retry shortly');
    expect(explainError(bubbled('PriceDiverged', PRICE_KEYS.USDC))).toBe('USDC price sources disagree right now — retry shortly');
  });

  it('maps errors of the called contract', () => {
    const own = new ContractFunctionRevertedError({
      abi: vaultManagerAbi,
      functionName: 'borrow',
      data: encodeErrorResult({ abi: vaultManagerAbi, errorName: 'InsufficientCollateral' }),
    });
    expect(explainError(own)).toBe('This would exceed your borrow limit');
  });

  it('explains leverage reverts: missing operator, netting into bad debt, an expired swap', () => {
    const vm = (errorName: 'NotOperator' | 'WouldLeaveBadDebt') =>
      new ContractFunctionRevertedError({
        abi: vaultManagerAbi,
        functionName: 'repayWithCollateral',
        data: encodeErrorResult({ abi: vaultManagerAbi, errorName }),
      });
    expect(explainError(vm('NotOperator'))).toBe('Authorise the leverage contract as your VaultManager operator first');
    expect(explainError(vm('WouldLeaveBadDebt'))).toBe('This would leave debt with no collateral behind it: repay that debt first');
    // Raised by SwapLeverageManager while the app called it through a wallet: decoded from the raw revert data.
    const expired = new ContractFunctionRevertedError({
      abi: vaultManagerAbi,
      functionName: 'borrow',
      data: encodeErrorResult({ abi: swapLeverageManagerAbi, errorName: 'Expired' }),
    });
    expect(explainError(expired)).toBe('The swap deadline passed before the transaction landed; try again');
  });

  it('keeps wallet rejections and plain errors readable', () => {
    expect(explainError(new BaseError('x', { cause: new UserRejectedRequestError(new Error('no')) }))).toBe('Transaction rejected in wallet');
    expect(explainError(new Error('Could not fetch ETH price updates\nstack'))).toBe('Could not fetch ETH price updates');
  });
});
