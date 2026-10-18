import { describe, expect, it, vi } from 'vitest';
import { BaseError, UserRejectedRequestError, encodeFunctionData, erc20Abi, type Hash, type TransactionReceipt } from 'viem';
import { GAS_FLOOR } from '@mezodot/sdk';
import {
  FALLBACK_GAS,
  gasFloorFor,
  gasLimitFor,
  intrinsicGas,
  markPriceUpdates,
  priceUpdatesIn,
  ranOutOfGas,
  runSteps,
  waitForBlock,
  type TxClient,
  type TxDriver,
  type TxRequest,
  type TxStep,
} from './runner';

const HUB_CHAIN = 31611;
const SPOKE_CHAIN = 84532;
const ACCOUNT = '0x00000000000000000000000000000000000000a1';
const TARGET = '0x00000000000000000000000000000000000000b2';

const request = (functionName: string, args: unknown[] = []): TxRequest => ({ address: TARGET, abi: [], functionName, args });
const step = (label: string, chainId: number, build: () => TxRequest | null, extra: Partial<TxStep> = {}): TxStep => ({
  label,
  chainId,
  request: async () => build(),
  ...extra,
});
const receipt = (hash: Hash, status: 'success' | 'reverted', gasUsed = 50_000n) =>
  ({ transactionHash: hash, status, gasUsed, blockNumber: 7n, logs: [] }) as unknown as TransactionReceipt;

type ReceiptFor = (hash: Hash, gas: bigint, emitReplaced: (reason: 'replaced' | 'repriced' | 'cancelled') => void) => Promise<TransactionReceipt>;

/** A wallet and chain fake: records writes, switches chains on request, mines what `receiptFor` returns. */
function fake({ estimate = 100_000n, receiptFor, startChain = HUB_CHAIN }: { estimate?: bigint; receiptFor?: ReceiptFor; startChain?: number } = {}) {
  let chainId = startChain;
  const writes: { functionName: string; chainId: number; gas: bigint; hash: Hash }[] = [];
  const switches: number[] = [];
  const explained: (TxRequest | null)[] = [];
  const client = {
    estimateContractGas: vi.fn<(args?: unknown) => Promise<bigint>>(async () => estimate),
    waitForTransactionReceipt: vi.fn(async ({ hash, onReplaced }: { hash: Hash; onReplaced?: (r: { reason: string }) => void }) => {
      const gas = writes.find((w) => w.hash === hash)!.gas;
      return (receiptFor ?? ((h) => Promise.resolve(receipt(h, 'success'))))(hash, gas, (reason) => onReplaced?.({ reason }));
    }),
    simulateContract: vi.fn(async () => {
      throw new Error('CapExceeded');
    }),
    // Receipts land in block 7: an RPC at that head already has every step's state.
    getBlockNumber: vi.fn<(args?: unknown) => Promise<bigint>>(async () => 7n),
  };
  const driver: TxDriver = {
    wallet: () => ({ address: ACCOUNT, chainId }),
    switchChain: async (id) => {
      switches.push(id);
      chainId = id;
    },
    client: () => client as unknown as TxClient,
    write: async (req, id, gas) => {
      const hash = `0x${(writes.length + 1).toString(16).padStart(64, '0')}` as Hash;
      writes.push({ functionName: req.functionName, chainId: id, gas, hash });
      return hash;
    },
    explain: (err, req) => {
      explained.push(req);
      return `explained: ${err instanceof Error ? err.message : String(err)}`;
    },
  };
  return { driver, client, writes, switches, explained };
}

describe('runSteps', () => {
  it('skips steps that are not needed and switches to each step’s chain before signing', async () => {
    const { driver, writes, switches } = fake();
    const outcome = await runSteps(driver, [
      step('Approve WETH', SPOKE_CHAIN, () => null),
      step('Lock WETH', SPOKE_CHAIN, () => request('deposit')),
      step('Borrow MUSD', HUB_CHAIN, () => request('borrow')),
    ]);
    expect(outcome.ok).toBe(true);
    expect(switches).toEqual([SPOKE_CHAIN, HUB_CHAIN]);
    expect(writes.map((w) => [w.functionName, w.chainId])).toEqual([
      ['deposit', SPOKE_CHAIN],
      ['borrow', HUB_CHAIN],
    ]);
    expect(outcome.steps.map((s) => s.status)).toEqual(['skipped', 'done', 'done']);
  });

  it('sizes gas as the larger of the floor and estimate × 1.3 + 20k', async () => {
    const { driver, writes } = fake({ estimate: 100_000n });
    await runSteps(driver, [
      step('Plain', HUB_CHAIN, () => request('a')),
      step('Relay', HUB_CHAIN, () => request('relayMessage'), { gasFloor: GAS_FLOOR.vaaRelay }),
      step('Supra', HUB_CHAIN, () => request('borrow', [0n, 1n, markPriceUpdates(['0x02aa'])])),
      step('Two Pyth', HUB_CHAIN, () => request('borrow', [0n, 1n, ['0x01aa', '0x01bb']])),
    ]);
    expect(writes.map((w) => w.gas)).toEqual([150_000n, GAS_FLOOR.vaaRelay, GAS_FLOOR.supraProof, 2n * GAS_FLOOR.pythUpdate]);
  });

  it('sends a step again with twice the gas once when it runs out of gas', async () => {
    const { driver, writes } = fake({
      receiptFor: async (hash, gas) => (writes.length === 1 ? receipt(hash, 'reverted', gas) : receipt(hash, 'success')),
    });
    const phases: [string, number][] = [];
    const outcome = await runSteps(driver, [step('Withdraw', HUB_CHAIN, () => request('withdraw'))], {
      onPhase: (_i, phase, attempt) => phases.push([phase, attempt]),
    });
    expect(outcome.ok).toBe(true);
    expect(writes.map((w) => w.gas)).toEqual([150_000n, 300_000n]);
    expect(phases).toContainEqual(['preparing', 1]);
  });

  it('gives up after the retry also runs out of gas', async () => {
    const { driver } = fake({ receiptFor: async (hash, gas) => receipt(hash, 'reverted', gas) });
    const outcome = await runSteps(driver, [step('Withdraw', HUB_CHAIN, () => request('withdraw'))]);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBe('Withdraw ran out of gas on-chain (300,000 of 300,000 gas)');
  });

  it('reports the steps that landed and the revert reason when a later step reverts on-chain', async () => {
    const { driver, writes } = fake({
      receiptFor: async (hash) => (writes.length === 2 ? receipt(hash, 'reverted', 60_000n) : receipt(hash, 'success')),
    });
    const outcome = await runSteps(driver, [
      step('Approve WETH', SPOKE_CHAIN, () => request('approve')),
      step('Lock WETH', SPOKE_CHAIN, () => request('deposit')),
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('Lock WETH reverted on-chain: explained: CapExceeded');
    expect(outcome.steps.map((s) => s.status)).toEqual(['done', 'failed']);
    expect(outcome.steps[0].hash).toBe(writes[0].hash);
  });

  it('treats a transaction cancelled in the wallet as a failure, even though its replacement succeeded', async () => {
    const { driver } = fake({
      receiptFor: async (hash, _gas, replaced) => {
        replaced('cancelled');
        return receipt(hash, 'success');
      },
    });
    const outcome = await runSteps(driver, [step('Supply MUSD', HUB_CHAIN, () => request('deposit'))]);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBe('explained: The transaction was cancelled in the wallet');
  });

  it('accepts a sped-up (repriced) transaction', async () => {
    const { driver } = fake({
      receiptFor: async (hash, _gas, replaced) => {
        replaced('repriced');
        return receipt(hash, 'success');
      },
    });
    expect((await runSteps(driver, [step('Supply MUSD', HUB_CHAIN, () => request('deposit'))])).ok).toBe(true);
  });

  it('stops waiting on request and reports the transaction as pending', async () => {
    const controller = new AbortController();
    const { driver } = fake({ receiptFor: () => new Promise(() => undefined) });
    const outcome = await runSteps(driver, [step('Lock WETH', SPOKE_CHAIN, () => request('deposit'))], {
      signal: controller.signal,
      onSubmitted: () => setTimeout(() => controller.abort(), 0),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.pending).toEqual({ hash: outcome.steps[0].hash, chainId: SPOKE_CHAIN });
    expect(outcome.steps[0].status).toBe('pending');
  });

  it('marks a declined signature as a rejection', async () => {
    const { driver } = fake();
    driver.write = async () => {
      throw new BaseError('declined', { cause: new UserRejectedRequestError(new Error('User rejected')) });
    };
    const outcome = await runSteps(driver, [step('Borrow MUSD', HUB_CHAIN, () => request('borrow'))]);
    expect(!outcome.ok && outcome.rejected).toBe(true);
    expect(!outcome.ok && outcome.steps[0].status).toBe('not-sent');
  });

  it('explains a failure while building a step without the previous step’s request', async () => {
    const { driver, explained } = fake();
    const outcome = await runSteps(driver, [
      step('Approve WETH', SPOKE_CHAIN, () => request('approve', [markPriceUpdates([], 'relay down')])),
      {
        label: 'Lock WETH',
        chainId: SPOKE_CHAIN,
        request: async () => {
          throw new Error('The gateway is paused');
        },
      },
    ]);
    expect(!outcome.ok && outcome.error).toBe('explained: The gateway is paused');
    expect(explained).toEqual([null]);
  });

  it('asks for a wallet when none is connected', async () => {
    const { driver } = fake();
    driver.wallet = () => ({ address: undefined, chainId: undefined });
    const outcome = await runSteps(driver, [step('Supply MUSD', HUB_CHAIN, () => request('deposit'))]);
    expect(!outcome.ok && outcome.error).toBe('explained: Connect a wallet to continue');
  });
});

describe('price updates and gas floors', () => {
  it('finds the update array a builder attached, with the relay failure that emptied it', () => {
    const updates = markPriceUpdates([], 'agent unreachable');
    expect(priceUpdatesIn(request('withdrawCollateral', [0n, 1n, ACCOUNT, updates]))).toEqual({ updates, relayError: 'agent unreachable' });
    expect(priceUpdatesIn(request('borrow', [0n, 1n, ['0x02ab']]))).toEqual({ updates: ['0x02ab'], relayError: null });
    expect(priceUpdatesIn(request('deposit', [TARGET, 1n]))).toBeNull();
    expect(priceUpdatesIn(null)).toBeNull();
  });

  it('takes the largest applicable floor', () => {
    expect(gasFloorFor({}, request('approve'))).toBe(0n);
    expect(gasFloorFor({ gasFloor: 80_000n }, request('borrow', [['0x01aa']]))).toBe(GAS_FLOOR.pythUpdate);
    expect(gasFloorFor({ gasFloor: 80_000n }, request('borrow', [['0x01aa', '0x02bb']]))).toBe(GAS_FLOOR.supraProof);
  });

  it('calls a revert that used ≥ 98% of its limit out of gas', () => {
    expect(ranOutOfGas({ status: 'reverted', gasUsed: 60_433n }, 60_534n)).toBe(true);
    expect(ranOutOfGas({ status: 'reverted', gasUsed: 51_000n }, 100_000n)).toBe(false);
    expect(ranOutOfGas({ status: 'success', gasUsed: 100_000n }, 100_000n)).toBe(false);
  });
});

describe('gas limits from node estimates (mezo-gas-estimate-oog)', () => {
  const approve: TxRequest = { address: TARGET, abi: erc20Abi, functionName: 'approve', args: [TARGET, 1n] };
  const intrinsic = intrinsicGas(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TARGET, 1n] }));
  /** A client answering `estimates` in order; the last one repeats. */
  const clientWith = (...estimates: bigint[]) => {
    const estimateContractGas = vi.fn(async () => (estimates.length > 1 ? estimates.shift()! : estimates[0]));
    return { client: { estimateContractGas } as unknown as TxClient, estimateContractGas };
  };

  it('counts calldata like the EVM: 4 gas per zero byte, 16 per other byte', () => {
    expect(intrinsicGas('0x')).toBe(21_000n);
    expect(intrinsicGas('0x00ff00')).toBe(21_024n);
  });

  it('trusts an estimate that includes contract execution', async () => {
    const { client, estimateContractGas } = clientWith(60_000n);
    expect(await gasLimitFor(client, {}, approve, ACCOUNT)).toBe(98_000n);
    expect(estimateContractGas).toHaveBeenCalledTimes(1);
  });

  it('asks again when the node estimated as if no contract code ran, and uses the second answer', async () => {
    const { client, estimateContractGas } = clientWith(intrinsic, 60_000n);
    expect(await gasLimitFor(client, {}, approve, ACCOUNT)).toBe(98_000n);
    expect(estimateContractGas).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generous limit when the node keeps ignoring the code', async () => {
    const { client } = clientWith(intrinsic + 100n, intrinsic + 100n);
    expect(await gasLimitFor(client, {}, approve, ACCOUNT)).toBe(FALLBACK_GAS);
  });

  it('never goes below the step floor or the minimum of a retry', async () => {
    expect(await gasLimitFor(clientWith(60_000n).client, { gasFloor: GAS_FLOOR.erc20Approve }, approve, ACCOUNT)).toBe(98_000n);
    expect(await gasLimitFor(clientWith(30_000n).client, { gasFloor: GAS_FLOOR.erc20Approve }, approve, ACCOUNT)).toBe(GAS_FLOOR.erc20Approve);
    expect(await gasLimitFor(clientWith(60_000n).client, {}, approve, ACCOUNT, 196_000n)).toBe(196_000n);
  });

  it('runs a step at the fallback limit instead of one sure to run out of gas', async () => {
    const { driver, writes, client } = fake();
    client.estimateContractGas.mockImplementation(async () => intrinsic);
    const outcome = await runSteps(driver, [step('Approve MUSD', HUB_CHAIN, () => approve)]);
    expect(outcome.ok).toBe(true);
    expect(writes.map((w) => w.gas)).toEqual([FALLBACK_GAS]);
  });
});

describe('steps after one that landed wait for an RPC that has its block (final review WEB-5)', () => {
  const approve = (log: string[]) => step('Approve MUSD', HUB_CHAIN, () => (log.push('build approve'), request('approve')));
  const supply = (log: string[]) => step('Supply MUSD', HUB_CHAIN, () => (log.push('build supply'), request('deposit')));

  it('builds and estimates the next step only once the RPC reports the block the approve landed in', async () => {
    const { driver, client } = fake(); // receipts land in block 7
    const log: string[] = [];
    const heads = [7n, 6n, 6n, 7n]; // the approve's estimate, then a replica one block behind for two polls
    client.getBlockNumber.mockImplementation(async () => {
      const head = heads.shift() ?? 7n;
      log.push(`head ${head}`);
      return head;
    });
    client.estimateContractGas.mockImplementation(async () => (log.push('estimate'), 100_000n));
    const outcome = await runSteps(driver, [approve(log), supply(log)], { landed: new Map([[HUB_CHAIN, 7n]]), blockPollMs: 0 });
    expect(outcome.ok).toBe(true);
    expect(log).toEqual(['head 7', 'build approve', 'estimate', 'head 6', 'head 6', 'head 7', 'build supply', 'estimate']);
  });

  it('remembers a head that stays below the stored block (a restarted devnet), so later runs do not wait again', async () => {
    const { driver, client } = fake();
    client.getBlockNumber.mockImplementation(async () => 3n); // the chain restarted below block 7
    const landed = new Map([[HUB_CHAIN, 7n]]);
    const outcome = await runSteps(driver, [supply([])], { landed, blockPollMs: 0 });
    expect(outcome.ok).toBe(true);
    // The supply landed in block 7 (the fake's receipts), above the lowered head: that is what is remembered.
    expect(landed.get(HUB_CHAIN)).toBe(7n);
    landed.set(HUB_CHAIN, 9n);
    await runSteps(driver, [supply([])], { landed, blockPollMs: 0 });
    expect(landed.get(HUB_CHAIN)).toBe(7n);
  });

  it('estimates once more when a lagging replica reverts the step after an approve, instead of failing the run', async () => {
    const { driver, client, writes } = fake();
    client.getBlockNumber.mockImplementation(async () => 8n);
    let supplyEstimates = 0;
    client.estimateContractGas.mockImplementation(async (args: unknown) => {
      if ((args as TxRequest).functionName !== 'deposit') return 100_000n;
      supplyEstimates++;
      // The first answer comes from a replica without the approve's block.
      if (supplyEstimates === 1) throw new Error('ERC20InsufficientAllowance');
      return 100_000n;
    });
    const outcome = await runSteps(driver, [approve([]), supply([])], { landed: new Map(), blockPollMs: 0 });
    expect(outcome.ok).toBe(true);
    expect(supplyEstimates).toBe(2);
    expect(writes.map((w) => w.functionName)).toEqual(['approve', 'deposit']);
  });

  it('fails as before when nothing landed earlier in the run, or the estimate keeps reverting', async () => {
    const { driver, client } = fake();
    client.getBlockNumber.mockImplementation(async () => 8n);
    client.estimateContractGas.mockImplementation(async () => {
      throw new Error('BorrowCapExceeded');
    });
    const alone = await runSteps(driver, [supply([])], { landed: new Map(), blockPollMs: 0 });
    expect(!alone.ok && alone.error).toBe('explained: BorrowCapExceeded');
    expect(client.estimateContractGas).toHaveBeenCalledTimes(1);

    client.estimateContractGas.mockImplementation(async (args: unknown) => {
      if ((args as TxRequest).functionName === 'deposit') throw new Error('BorrowCapExceeded');
      return 100_000n;
    });
    const after = await runSteps(driver, [approve([]), supply([])], { landed: new Map(), blockPollMs: 0 });
    expect(!after.ok && after.error).toBe('explained: BorrowCapExceeded');
    expect(!after.ok && after.steps.map((s) => s.status)).toEqual(['done', 'not-sent']);
  });

  it('remembers the block across runs, so a retry right after a failed run reads the approve it already paid for', async () => {
    const landed = new Map<number, bigint>();
    const { driver, client } = fake();
    await runSteps(driver, [approve([])], { landed, blockPollMs: 0 });
    expect(landed.get(HUB_CHAIN)).toBe(7n);
    // The retry's first step reads the allowance: not before the RPC reports the block the approve landed in.
    const log: string[] = [];
    const heads = [6n, 7n];
    client.getBlockNumber.mockImplementation(async () => {
      const head = heads.shift() ?? 7n;
      log.push(`head ${head}`);
      return head;
    });
    await runSteps(driver, [approve(log)], { landed, blockPollMs: 0 });
    expect(log.slice(0, 3)).toEqual(['head 6', 'head 7', 'build approve']);
  });

  it('gives up waiting after a bounded number of polls, or at once when the RPC cannot tell', async () => {
    const behind = { getBlockNumber: vi.fn(async () => 5n) } as unknown as TxClient;
    expect(await waitForBlock(behind, 7n, 3, 0)).toBe(false);
    expect(behind.getBlockNumber).toHaveBeenCalledTimes(3);
    const failing = { getBlockNumber: vi.fn().mockRejectedValue(new Error('429')) } as unknown as TxClient;
    expect(await waitForBlock(failing, 7n, 3, 0)).toBe(false);
    expect(failing.getBlockNumber).toHaveBeenCalledTimes(1);
  });
});
