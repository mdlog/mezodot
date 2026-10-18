import { describe, expect, it } from 'vitest';
import { Eip1559FeesNotSupportedError, WaitForTransactionReceiptTimeoutError, type Hex } from 'viem';
import { GAS_FLOOR } from '@mezodot/sdk';
import { StuckTransactionError, TxSender, bumped, ranOutOfGas } from '../src/tx';

type Write = { gas: bigint; nonce: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint; functionName?: string };
type Receipt = { status: 'success' | 'reverted'; gasUsed: bigint; transactionHash: Hex; logs: [] };

const KEEPER = '0x00000000000000000000000000000000000000ee';
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

/**
 * A fake chain for one keeper account: every write is mined at once (unless `mine` says otherwise) and moves the
 * account's nonce; receipts come from `receiptFor`.
 */
function fakeChain(opts: {
  estimate?: () => Promise<bigint>;
  receiptFor?: (w: Write, i: number) => Partial<Receipt>;
  mine?: (w: Write, i: number) => boolean;
  pendingLags?: boolean;
  legacy?: boolean;
  events?: string[];
}) {
  const writes: Write[] = [];
  const receipts = new Map<Hex, Receipt>();
  let confirmed = 0;
  const client = {
    estimateContractGas: opts.estimate ?? (async () => 100_000n),
    estimateFeesPerGas: async () => {
      if (opts.legacy) throw new Eip1559FeesNotSupportedError();
      return { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
    },
    getGasPrice: async () => 500n,
    getTransactionCount: async ({ blockTag }: { blockTag: 'pending' | 'latest' }) => (blockTag === 'pending' && opts.pendingLags ? 0 : confirmed),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new WaitForTransactionReceiptTimeoutError({ hash });
      opts.events?.push(`receipt:${hash.slice(-2)}`);
      return r;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new Error('not found');
      return r;
    },
  };
  const wallet = {
    account: { address: KEEPER },
    writeContract: async (w: Write) => {
      const i = writes.push(w) - 1;
      const hash = hashOf(i + 1);
      opts.events?.push(`write:${hash.slice(-2)}:nonce${w.nonce}`);
      if (opts.mine?.(w, i) ?? true) {
        receipts.set(hash, { status: 'success', gasUsed: 50_000n, transactionHash: hash, logs: [], ...opts.receiptFor?.(w, i) });
        confirmed = Math.max(confirmed, w.nonce + 1);
      }
      return hash;
    },
  };
  const logs: string[] = [];
  const sender = new TxSender('mezo-testnet', client as never, wallet as never, { receiptTimeoutMs: 10, log: (_s, m) => logs.push(m) });
  return { sender, writes, logs, client };
}

const request = { address: '0x0000000000000000000000000000000000000001', abi: [], functionName: 'updatePrices', args: [] };

describe('TxSender gas limits (Mezo testnet: estimates far below what execution needs)', () => {
  it('never goes below the call type floor', async () => {
    const { sender, writes } = fakeChain({ estimate: async () => 31_000n });
    await sender.send(request, { kind: 'pyth-push', floor: GAS_FLOOR.pythUpdate });
    expect(writes[0].gas).toBe(GAS_FLOOR.pythUpdate);
  });

  it('keeps the buffered estimate when it is above the floor', async () => {
    const { sender, writes } = fakeChain({ estimate: async () => 1_000_000n });
    await sender.send(request, { kind: 'liquidation', floor: GAS_FLOOR.supraProof });
    expect(writes[0].gas).toBe(1_320_000n);
  });

  it('retries once with double the limit when the receipt shows it ran out of gas', async () => {
    // Live: a push limited to 60,534 gas reverted after using 60,433.
    const { sender, writes, logs } = fakeChain({
      estimate: async () => 30_000n,
      receiptFor: (w, i) => (i === 0 ? { status: 'reverted', gasUsed: (w.gas * 99n) / 100n } : { status: 'success', gasUsed: 130_000n }),
    });
    const sent = await sender.send(request, { kind: 'pyth-push', floor: GAS_FLOOR.pythUpdate });
    expect(writes.map((w) => w.gas)).toEqual([GAS_FLOOR.pythUpdate, 2n * GAS_FLOOR.pythUpdate]);
    expect(writes.map((w) => w.nonce)).toEqual([0, 1]);
    expect(sent.receipt.status).toBe('success');
    expect(sender.counts['pyth-push']).toEqual({ out_of_gas: 1, success: 1 });
    expect(logs.some((l) => /ran out of gas; retrying/.test(l))).toBe(true);
  });

  it('does not resend an out-of-gas call that no longer estimates (e.g. someone else liquidated)', async () => {
    let calls = 0;
    const { sender, writes } = fakeChain({
      estimate: async () => {
        if (calls++ > 0) throw new Error('execution reverted: PositionHealthy()');
        return 600_000n;
      },
      receiptFor: (w) => ({ status: 'reverted', gasUsed: w.gas }),
    });
    const sent = await sender.send(request, { kind: 'liquidation', floor: GAS_FLOOR.liquidation });
    expect(writes).toHaveLength(1);
    expect(sent.receipt.status).toBe('reverted');
  });

  it('a revert that left gas unused is an ordinary revert, not retried', async () => {
    const { sender, writes } = fakeChain({ receiptFor: () => ({ status: 'reverted', gasUsed: 60_000n }) });
    await sender.send(request, { kind: 'relay-deposit', floor: GAS_FLOOR.vaaRelay });
    expect(writes).toHaveLength(1);
    expect(sender.counts['relay-deposit']).toEqual({ reverted: 1 });
    expect(ranOutOfGas({ status: 'reverted', gasUsed: 245_000n }, 250_000n)).toBe(true);
    expect(ranOutOfGas({ status: 'success', gasUsed: 250_000n }, 250_000n)).toBe(false);
  });
});

describe('TxSender nonces (relayer, liquidator, pusher and MCP share one keeper account)', () => {
  it('serializes concurrent sends: the second is prepared only after the first is mined', async () => {
    const events: string[] = [];
    const { sender, writes } = fakeChain({ events });
    await Promise.all([
      sender.send(request, { kind: 'pyth-push' }),
      sender.send(request, { kind: 'liquidation' }),
      sender.send(request, { kind: 'relay-deposit' }),
    ]);
    expect(writes.map((w) => w.nonce)).toEqual([0, 1, 2]);
    expect(events).toEqual(['write:01:nonce0', 'receipt:01', 'write:02:nonce1', 'receipt:02', 'write:03:nonce2', 'receipt:03']);
  });

  it('a failing send does not block the next one', async () => {
    let n = 0;
    const { sender, writes } = fakeChain({
      estimate: async () => {
        if (n++ === 0) throw new Error('execution reverted');
        return 100_000n;
      },
    });
    const results = await Promise.allSettled([sender.send(request, { kind: 'a' }), sender.send(request, { kind: 'b' })]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(writes).toHaveLength(1);
    expect(sender.lastError).toMatch(/execution reverted/);
  });

  it('never reuses a mined nonce when the RPC reports a stale pending count', async () => {
    const { sender, writes } = fakeChain({ pendingLags: true });
    await sender.send(request, { kind: 'a' });
    await sender.send(request, { kind: 'b' });
    expect(writes.map((w) => w.nonce)).toEqual([0, 1]);
  });

  it('replaces an unmined transaction at the same nonce with higher fees, then takes the nonce over on the next send', async () => {
    let stuck = true;
    const { sender, writes } = fakeChain({ mine: () => !stuck });
    const err = await sender.send(request, { kind: 'relay-release' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StuckTransactionError);
    // The first attempt and two replacements, all at nonce 0, each with fees at least 30% higher.
    expect(writes.map((w) => w.nonce)).toEqual([0, 0, 0]);
    expect(writes[1].maxFeePerGas!).toBeGreaterThanOrEqual((writes[0].maxFeePerGas! * 13n) / 10n);
    expect(writes[2].maxPriorityFeePerGas!).toBeGreaterThanOrEqual((writes[1].maxPriorityFeePerGas! * 13n) / 10n);
    expect(sender.stuckSince).not.toBeNull();
    expect(sender.counts['relay-release']).toEqual({ stuck: 1 });

    stuck = false;
    await sender.send(request, { kind: 'pyth-push' });
    expect(writes[3].nonce).toBe(0); // not queued behind the stuck transaction at nonce 1
    expect(writes[3].maxFeePerGas!).toBeGreaterThan(writes[2].maxFeePerGas!);
    expect(sender.stuckSince).toBeNull();
  });

  it('uses a legacy gas price where the chain has no base fee', async () => {
    const { sender, writes } = fakeChain({ legacy: true });
    await sender.send(request, { kind: 'a' });
    expect(writes[0].gasPrice).toBe(500n);
    expect(writes[0].maxFeePerGas).toBeUndefined();
  });

  it('bumps every fee field and never goes below the network price', () => {
    expect(bumped({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, { maxFeePerGas: 90n, maxPriorityFeePerGas: 50n })).toEqual({
      maxFeePerGas: 131n,
      maxPriorityFeePerGas: 50n,
    });
    expect(bumped({ gasPrice: 100n }, { gasPrice: 200n })).toEqual({ gasPrice: 200n });
  });
});

describe('TxSender and transactions it did not send (a previous run, another process with the key)', () => {
  it('queues behind a fresh foreign transaction, but takes its nonce over once it stays pending past the receipt timeout', async () => {
    let t = 0;
    let confirmed = 0;
    const pendingNonces = new Set<number>([0]); // left by the previous run, underpriced: never mined on its own
    const writes: Write[] = [];
    const receipts = new Map<Hex, Receipt>();
    const client = {
      estimateContractGas: async () => 100_000n,
      estimateFeesPerGas: async () => ({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }),
      getGasPrice: async () => 500n,
      getTransactionCount: async ({ blockTag }: { blockTag: string }) => (blockTag === 'latest' ? confirmed : confirmed + pendingNonces.size),
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const r = receipts.get(hash);
        if (!r) throw new WaitForTransactionReceiptTimeoutError({ hash });
        return r;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipts.get(hash) ?? Promise.reject(new Error('not found')),
    };
    const wallet = {
      account: { address: KEEPER },
      writeContract: async (w: Write) => {
        const hash = hashOf(writes.push(w));
        // Only the next nonce can be mined; anything above it waits.
        if (w.nonce === confirmed) {
          pendingNonces.delete(w.nonce);
          confirmed += 1;
          receipts.set(hash, { status: 'success', gasUsed: 50_000n, transactionHash: hash, logs: [] });
        } else pendingNonces.add(w.nonce);
        return hash;
      },
    };
    const logs: string[] = [];
    const sender = new TxSender('mezo-testnet', client as never, wallet as never, { receiptTimeoutMs: 10, log: (_s, m) => logs.push(m), now: () => t });

    // Just seen: maybe the other sender's transaction is about to be mined. Ours queues behind it (nonce 1).
    await expect(sender.send(request, { kind: 'a' })).rejects.toBeInstanceOf(StuckTransactionError);
    expect(writes.map((w) => w.nonce)).toEqual([1, 1, 1]);

    t = 11; // still pending past the receipt timeout: take nonce 0 over with higher fees
    await sender.send(request, { kind: 'b' });
    expect(writes[3].nonce).toBe(0);
    expect(writes[3].maxFeePerGas).toBe(1_301n);
    expect(logs).toContain('taking over a transaction another sender left pending');

    // Our own stuck transaction at nonce 1 is next in line: the following send replaces it.
    await sender.send(request, { kind: 'c' });
    expect(writes[4].nonce).toBe(1);
    expect(sender.stuckSince).toBeNull();
    await sender.send(request, { kind: 'd' });
    expect(writes[5].nonce).toBe(2);
  });
});
