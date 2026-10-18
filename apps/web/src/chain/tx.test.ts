import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult, keccak256, slice, toHex, type Address } from 'viem';
import { PRICE_KEYS, leverageManagerAbi, oracleRouterAbi, vaultManagerAbi } from '@mezodot/sdk';
import type { ActiveTx } from '../state/TxContext';
import { HUB, SPOKES } from './env';
import { markPriceUpdates } from './runner';
import { busyLabel, explainTxError, pausedMessage } from './tx';

const contracts = HUB.deployment!.contracts;
const paused = (abi: typeof vaultManagerAbi | typeof leverageManagerAbi) =>
  new ContractFunctionRevertedError({ abi, functionName: 'borrow', data: slice(keccak256(toHex('EnforcedPause()')), 0, 4) });
const at = (address: Address) => ({ address, abi: [], functionName: 'x' });

describe('pause messages name what is blocked and what still works', () => {
  it('per contract', () => {
    expect(pausedMessage(contracts.vaultManager)).toMatch(/^Borrowing is paused.*Repaying, withdrawing and adding collateral still work$/);
    expect(pausedMessage(contracts.pMUSD)).toMatch(/^The MUSD pool is paused: new supply and borrows are blocked/);
    expect(pausedMessage(contracts.leverageManager)).toMatch(/^Opening leveraged positions is paused/);
    const spoke = SPOKES.find((s) => s.deployment)!;
    expect(pausedMessage(spoke.deployment!.contracts.spokeGateway)).toBe(`The ${spoke.label} gateway is paused: new locks are blocked. Releases still work`);
  });

  it('for a pause raised by the called contract or bubbled up from a callee', () => {
    const own = new ContractFunctionRevertedError({
      abi: vaultManagerAbi,
      functionName: 'borrow',
      data: encodeErrorResult({ abi: vaultManagerAbi, errorName: 'EnforcedPause' }),
    });
    expect(explainTxError(own, at(contracts.vaultManager))).toBe(pausedMessage(contracts.vaultManager));
    // LeverageManager has no EnforcedPause of its own: the pool's revert arrives as a bare selector.
    expect(explainTxError(paused(leverageManagerAbi), at(contracts.leverageManager))).toBe(pausedMessage(contracts.leverageManager));
  });

  it('adds the relay failure when the contract refused a call that went out without the prices it needed', () => {
    const request = { ...at(contracts.vaultManager), args: [0n, 1n, markPriceUpdates([], 'the Mezodot agent did not return ETH prices: fetch failed')] };
    const unavailable = new ContractFunctionRevertedError({
      abi: oracleRouterAbi,
      functionName: 'getPrice',
      data: encodeErrorResult({ abi: oracleRouterAbi, errorName: 'PriceUnavailable', args: [PRICE_KEYS.ETH] }),
    });
    expect(explainTxError(unavailable, request)).toBe(
      'ETH price is unavailable right now (stale or too uncertain) — retry shortly. Fresh prices could not be attached (the Mezodot agent did not return ETH prices: fetch failed); retry once the Mezodot agent is reachable',
    );
    expect(explainTxError(new Error('Nope'), at(contracts.vaultManager))).toBe('Nope');
  });

  it('leaves the relay out of failures that are not the contract’s refusal', () => {
    const request = { ...at(contracts.vaultManager), args: [0n, 1n, markPriceUpdates([], 'agent unreachable')] };
    const declined = new BaseError('declined', { cause: new UserRejectedRequestError(new Error('User rejected')) });
    expect(explainTxError(declined, request)).toBe('Transaction rejected in wallet');
    expect(explainTxError(new Error('HTTP request failed'), request)).toBe('HTTP request failed');
  });
});

describe('busy labels', () => {
  const tx = (patch: Partial<ActiveTx>): ActiveTx => ({
    owner: 'me',
    title: 'Lock WETH',
    steps: [{ label: 'Approve WETH', chainId: HUB.chain.id }],
    index: 0,
    phase: 'preparing',
    attempt: 0,
    hashes: [null],
    finished: [null],
    phaseSince: 0,
    ...patch,
  });

  it('describe this button’s own run, phase by phase', () => {
    expect(busyLabel(null, 'me')).toBeNull();
    expect(busyLabel(tx({}), 'me')).toBe('Approve WETH — preparing…');
    expect(busyLabel(tx({ phase: 'switching' }), 'me')).toBe(`Switching to ${HUB.label}…`);
    expect(busyLabel(tx({ phase: 'signing' }), 'me')).toBe('Approve WETH — confirm in wallet');
    expect(busyLabel(tx({ phase: 'confirming' }), 'me')).toBe('Approve WETH — waiting for confirmation');
    expect(busyLabel(tx({ attempt: 1 }), 'me')).toBe('Approve WETH — ran out of gas, retrying…');
  });

  it('block every other button while a run holds the wallet', () => {
    expect(busyLabel(tx({}), 'someone else')).toBe('Another transaction is in progress…');
  });
});
