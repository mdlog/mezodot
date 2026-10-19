import { describe, expect, it } from 'vitest';
import {
  Eip1559FeesNotSupportedError,
  TimeoutError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  hexToString,
  keccak256,
  toHex,
  type Hex,
} from 'viem';
import { GAS_FLOOR, spokeGatewayAbi } from '@mezodot/sdk';
import { NonceConsumedError, SentTransactionError, StuckTransactionError, TxSender, bumped, ranOutOfGas, type BroadcastTx } from '../src/tx';
import { rpcError, scriptedChain } from './chain';

type Write = { gas: bigint; nonce: number; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint; data?: Hex };
type Receipt = { status: 'success' | 'reverted'; gasUsed: bigint; transactionHash: Hex; logs: [] };

const KEEPER = '0x00000000000000000000000000000000000000ee';

/** Stand-in for local signing: the "raw transaction" is the request as JSON, so the fake node can read it back. */
const encodeTx = (tx: object): Hex => toHex(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
const decodeTx = (raw: Hex): Write =>
  JSON.parse(hexToString(raw), (_k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) as Write;

/** A keeper wallet double that signs locally (like privateKeyToAccount) and broadcasts through `broadcast`. */
const fakeWallet = (broadcast: (w: Write, hash: Hex) => void) => ({
  account: { address: KEEPER, type: 'local', signTransaction: async (tx: object) => encodeTx(tx) },
  chain: { id: 31_611 },
  sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
    const hash = keccak256(serializedTransaction);
    broadcast(decodeTx(serializedTransaction), hash);
    return hash;
  },
});

/**
 * A fake chain for one keeper account: every broadcast is mined at once (unless `mine` says otherwise) and moves the
 * account's nonce; receipts come from `receiptFor`. Events name transactions by their position (1 = first sent).
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
  const index = new Map<Hex, number>();
  let confirmed = 0;
  const client = {
    estimateContractGas: opts.estimate ?? (async () => 100_000n),
    estimateFeesPerGas: async () => {
      if (opts.legacy) throw new Eip1559FeesNotSupportedError();
      return { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };
    },
    getGasPrice: async () => 500n,
    getTransactionCount: async ({ blockTag }: { blockTag: 'pending' | 'latest' }) => (blockTag === 'pending' && opts.pendingLags ? 0 : confirmed),
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      const r = receipts.get(hash);
      if (!r) throw new TransactionReceiptNotFoundError({ hash });
      opts.events?.push(`receipt:${index.get(hash)}`);
      return r;
    },
    getTransaction: async ({ hash }: { hash: Hex }) => {
      if (!index.has(hash)) throw new TransactionNotFoundError({ hash });
      return { hash };
    },
  };
  const wallet = fakeWallet((w, hash) => {
    const i = writes.push(w) - 1;
    index.set(hash, i + 1);
    opts.events?.push(`write:${i + 1}:nonce${w.nonce}`);
    if (opts.mine?.(w, i) ?? true) {
      receipts.set(hash, { status: 'success', gasUsed: 50_000n, transactionHash: hash, logs: [], ...opts.receiptFor?.(w, i) });
      confirmed = Math.max(confirmed, w.nonce + 1);
    }
  });
  const logs: string[] = [];
  const sender = new TxSender('mezo-testnet', client as never, wallet as never, { receiptTimeoutMs: 10, pollMs: 1, log: (_s, m) => logs.push(m) });
  return { sender, writes, logs, client };
}

const request = { address: '0x0000000000000000000000000000000000000001', abi: spokeGatewayAbi, functionName: 'receiveMessage', args: ['0x01'] };
/** A release delivery (SpokeGateway.receiveMessage) carrying `vaa`. */
const relay = (vaa: Hex) => ({ address: '0x00000000000000000000000000000000000000ab', abi: spokeGatewayAbi, functionName: 'receiveMessage', args: [vaa] });

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

describe('TxSender nonces (relayer, liquidator and pusher share one keeper account)', () => {
  it('serializes concurrent sends: the second is prepared only after the first is mined', async () => {
    const events: string[] = [];
    const { sender, writes } = fakeChain({ events });
    await Promise.all([
      sender.send(request, { kind: 'pyth-push' }),
      sender.send(request, { kind: 'liquidation' }),
      sender.send(request, { kind: 'relay-deposit' }),
    ]);
    expect(writes.map((w) => w.nonce)).toEqual([0, 1, 2]);
    expect(events).toEqual(['write:1:nonce0', 'receipt:1', 'write:2:nonce1', 'receipt:2', 'write:3:nonce2', 'receipt:3']);
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
    expect((err as StuckTransactionError).hashes).toHaveLength(3); // every attempt, for whoever settles it later
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

  it('reports every transaction of a request before it is broadcast, so a caller can persist it', async () => {
    let stuck = true;
    const { sender } = fakeChain({ mine: () => !stuck });
    const seen: BroadcastTx[] = [];
    const err = (await sender.send(request, { kind: 'swap', onBroadcast: (tx) => seen.push(tx) }).catch((e: unknown) => e)) as StuckTransactionError;
    expect(seen.map((tx) => [tx.nonce, tx.hashes.length])).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(seen.at(-1)!.hashes).toEqual(err.hashes);
    stuck = false;
    expect(await sender.settle(0, err.hashes)).toEqual({ status: 'pending' }); // nothing holds nonce 0 yet
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
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => receipts.get(hash) ?? Promise.reject(new TransactionReceiptNotFoundError({ hash })),
      getTransaction: async ({ hash }: { hash: Hex }) => Promise.reject(new TransactionNotFoundError({ hash })),
    };
    const wallet = fakeWallet((w, hash) => {
      writes.push(w);
      // Only the next nonce can be mined; anything above it waits.
      if (w.nonce === confirmed) {
        pendingNonces.delete(w.nonce);
        confirmed += 1;
        receipts.set(hash, { status: 'success', gasUsed: 50_000n, transactionHash: hash, logs: [] });
      } else pendingNonces.add(w.nonce);
    });
    const logs: string[] = [];
    const sender = new TxSender('mezo-testnet', client as never, wallet as never, {
      receiptTimeoutMs: 10,
      pollMs: 1,
      log: (_s, m) => logs.push(m),
      now: () => t,
    });

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

// --- real viem clients over a scripted chain ---------------------------------------------------------------------

const sender = (chain: ReturnType<typeof scriptedChain>, opts: { now?: () => number } = {}) =>
  new TxSender('eth-sepolia', chain.client, chain.wallet, { receiptTimeoutMs: 30, pollMs: 2, log: () => {}, ...opts });

describe('TxSender trusts only receipts of its own transactions (final review A1)', () => {
  /** Mines `winner()` right after the second receipt lookup of the transaction `ours()` names (it was seen pending). */
  const raceAfterSecondLookup = (ours: (c: ReturnType<typeof scriptedChain>) => Hex | undefined, winner: () => Hex) => {
    let lookups = 0;
    return (method: string, params: unknown[], c: ReturnType<typeof scriptedChain>) => {
      if (method === 'eth_getTransactionReceipt' && params[0] === ours(c) && ++lookups === 2) c.mine(winner());
    };
  };

  it('a takeover whose nonce goes to the stuck transaction it replaced did not happen', async () => {
    // Release X stays unmined through every fee bump; release Y takes its nonce over; a builder that still had X's
    // last attempt mines that one instead. viem's replacement detection alone would hand Y the receipt of X.
    const chain = scriptedChain({
      onCall: raceAfterSecondLookup(
        (c) => c.accepted[3],
        () => chain.accepted[2],
      ),
    });
    const s = sender(chain);
    await expect(s.send(relay(`0x${'a1'.repeat(40)}`), { kind: 'relay-release' })).rejects.toBeInstanceOf(StuckTransactionError);
    const y = await s.send(relay(`0x${'b2'.repeat(40)}`), { kind: 'relay-release' }).then(
      (sent) => ({ resolvedWith: sent.hash === chain.accepted[2] ? "the receipt of X's last attempt" : sent.hash }),
      (e: unknown) => e,
    );
    // Y did not happen: never "delivered" on the strength of X's receipt. Its error names only Y's own transaction.
    expect(y).toMatchObject({ name: 'NonceConsumedError', nonce: 0, hashes: [chain.accepted[3]] });
    expect(s.counts['relay-release']).toEqual({ stuck: 1, unknown: 1 });
    expect(s.stuckSince).toBeNull(); // nonce 0 is used now
    // The next request gets the next nonce.
    const next = await s.send(relay('0x03'), { kind: 'relay-release' }).catch((e: unknown) => e);
    expect(chain.nonceOf(chain.accepted.at(-1)!)).toBe(1);
    expect(next).toBeInstanceOf(StuckTransactionError); // nothing mines it here: what matters is its nonce
  });

  it('a takeover of a foreign pending transaction that gets mined after all did not happen either', async () => {
    let t = 0;
    // The other sender's transaction wins the race against our takeover of its nonce.
    const chain = scriptedChain({
      onCall: raceAfterSecondLookup(
        (c) => c.accepted.find((h) => c.nonceOf(h) === 0),
        () => foreign,
      ),
    });
    const foreign = chain.foreign(0);
    const s = sender(chain, { now: () => t });
    await expect(s.send(request, { kind: 'a' })).rejects.toBeInstanceOf(StuckTransactionError); // queued behind it at nonce 1
    t = 1_000; // the foreign transaction stayed pending past the receipt timeout: nonce 0 is taken over
    const b = await s.send(request, { kind: 'b' }).then(
      (sent) => ({ resolvedWith: sent.hash === foreign ? 'the receipt of the foreign transaction' : sent.hash }),
      (e: unknown) => e,
    );
    expect(b).toMatchObject({ name: 'NonceConsumedError', nonce: 0 });
    expect((b as NonceConsumedError).hashes).not.toContain(foreign);
  });
});

describe('TxSender never reports a broadcast transaction as failed (final review A2)', () => {
  it('waits out failing receipt lookups (a rate-limited public RPC) instead of failing the send', async () => {
    const chain = scriptedChain({ onSend: (h, _tx, c) => c.mine(h) });
    chain.failReceipts(5);
    const s = sender(chain);
    const sent = await s.send(request, { kind: 'pyth-push' });
    expect(sent.hash).toBe(chain.accepted[0]);
    expect(s.counts['pyth-push']).toEqual({ success: 1 });
  });

  it.each([
    ['times out after the node took it', () => new TimeoutError({ body: { method: 'eth_sendRawTransaction' }, url: 'https://rpc.example/KEY' })],
    ['is answered "already known" by a fallback RPC', () => rpcError('already known')],
  ])('settles a broadcast that %s from its receipt', async (_what, failure) => {
    const chain = scriptedChain({
      onSend: (h, _tx, c) => {
        c.mine(h);
        throw failure();
      },
    });
    const s = sender(chain);
    const sent = await s.send(request, { kind: 'liquidation' });
    expect(sent.hash).toBe(chain.accepted[0]);
    expect(sent.receipt.status).toBe('success');
  });

  it("waits out a receipt endpoint that lags the nonce count, instead of calling its own mined transaction someone else's", async () => {
    const chain = scriptedChain({
      onSend: (h, _tx, c) => {
        c.mine(h);
        c.lagReceipts(10); // the nonce count moves at once; the receipts replica answers "not found" for 10 lookups
      },
    });
    const s = sender(chain);
    const sent = await s.send(request, { kind: 'pyth-push' });
    expect(sent.hash).toBe(chain.accepted[0]);
    expect(s.counts['pyth-push']).toEqual({ success: 1 });
  });

  it('a transaction the node refused is an ordinary failure, reported at once', async () => {
    const chain = scriptedChain({ refuse: () => 'insufficient funds for gas * price + value' });
    const s = sender(chain);
    const err = await s.send(request, { kind: 'approve' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SentTransactionError);
    expect(String((err as Error).message)).toMatch(/insufficient funds/);
    expect(s.counts.approve).toEqual({ failed: 1 });
    expect(chain.calls.filter((m) => m === 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('broadcasts nothing when the caller cannot record what it is about to send', async () => {
    const chain = scriptedChain();
    const s = sender(chain);
    const err = await s
      .send(request, {
        kind: 'liquidation',
        onBroadcast: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      })
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(SentTransactionError); // nothing left: an ordinary failure
    expect(chain.calls).not.toContain('eth_sendRawTransaction');
    expect(s.stuckSince).toBeNull();
    expect(s.counts.liquidation).toEqual({ failed: 1 });
  });

  it('settles an earlier request from chain state: mined, or dropped once another transaction holds its nonce', async () => {
    const chain = scriptedChain();
    const s = sender(chain);
    const stuck = (await s.send(request, { kind: 'swap' }).catch((e: unknown) => e)) as StuckTransactionError;
    expect(await s.settle(stuck.nonce, stuck.hashes)).toEqual({ status: 'pending' });
    chain.mine(stuck.hashes[0]); // the first attempt was mined after all
    expect(await s.settle(stuck.nonce, stuck.hashes)).toMatchObject({ status: 'mined', receipt: { transactionHash: stuck.hashes[0] } });
    expect(await s.settle(stuck.nonce, [keccak256('0x01')])).toEqual({ status: 'dropped' });
  });
});

describe('TxSender stuck state (final review A6)', () => {
  it('clears once the stuck nonce is mined, even when nothing else is sent', async () => {
    const chain = scriptedChain();
    const s = sender(chain);
    const stuck = (await s.send(request, { kind: 'relay-release' }).catch((e: unknown) => e)) as StuckTransactionError;
    expect(s.stuckSince).not.toBeNull();
    await s.refreshStuck();
    expect(s.stuckSince).not.toBeNull(); // still pending
    chain.mine(stuck.hashes.at(-1)!);
    await s.refreshStuck();
    expect(s.stuckSince).toBeNull();
  });

  it('clears once the stuck transaction left the mempool unmined, after two checks agree', async () => {
    const chain = scriptedChain();
    const s = sender(chain);
    const stuck = (await s.send(request, { kind: 'relay-release' }).catch((e: unknown) => e)) as StuckTransactionError;
    chain.evict(stuck.nonce);
    await s.refreshStuck();
    expect(s.stuckSince).not.toBeNull(); // one look could be a replica that has not seen it yet
    await s.refreshStuck();
    expect(s.stuckSince).toBeNull();
  });
});
