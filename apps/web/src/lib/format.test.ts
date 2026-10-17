import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult } from 'viem';
import { vaultManagerAbi } from '@mezodot/sdk';
import { explainError } from '../chain/tx';
import { compactUsd, fmtApy, fmtHealth, fmtToken, money, shortAddress, timeAgo, units } from './format';

describe('format', () => {
  it('formats token amounts from base units', () => {
    expect(units(1_500_000n, 6)).toBe(1.5);
    expect(fmtToken(2_001_800_000_000_000_000_000n, 18, 1)).toBe('2,001.8');
  });

  it('formats money, compact USD, APY and health', () => {
    expect(money(-12.5, 2)).toBe('−$12.50');
    expect(compactUsd(46_100_000)).toBe('$46.10M');
    expect(compactUsd(9_600)).toBe('$9.6K');
    expect(fmtApy(0.0285)).toBe('2.85%');
    expect(fmtHealth(Infinity)).toBe('—');
    expect(fmtHealth(1.2738)).toBe('1.27×');
  });

  it('formats addresses and relative time', () => {
    expect(shortAddress('0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC')).toBe('0x3C44…93BC');
    expect(timeAgo(Date.now() - 2 * 3_600_000)).toBe('2h ago');
  });
});

describe('explainError', () => {
  it('maps contract custom errors to plain language', () => {
    const data = encodeErrorResult({ abi: vaultManagerAbi, errorName: 'InsufficientCollateral' });
    const err = new BaseError('reverted', { cause: new ContractFunctionRevertedError({ abi: vaultManagerAbi, data, functionName: 'borrow' }) });
    expect(explainError(err)).toBe('This would exceed your borrow limit');
  });

  it('recognises wallet rejections', () => {
    const err = new BaseError('rejected', { cause: new UserRejectedRequestError(new Error('User denied')) });
    expect(explainError(err)).toBe('Transaction rejected in wallet');
  });

  it('falls back to the first line of other errors', () => {
    expect(explainError(new Error('boom\nstack'))).toBe('boom');
  });
});
