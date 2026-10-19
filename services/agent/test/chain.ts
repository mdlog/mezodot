import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  keccak256,
  parseTransaction,
  toHex,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionSerializableEIP1559,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Wallet } from '../src/context';

/** Anvil's well-known test key #1: the keeper of every scripted chain. */
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const BASE_FEE = 10_000_000_000n;

export const testChain = defineChain({
  id: 31_611,
  name: 'scripted',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: ['http://scripted.invalid'] } },
});

type Tx = TransactionSerializableEIP1559 & { nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
/** A JSON-RPC error answer, as a node sends it (viem maps the code to its RPC error classes). */
export const rpcError = (message: string, code = -32_000) => Object.assign(new Error(message), { code });

export type ScriptedChain = ReturnType<typeof scriptedChain>;

/**
 * One keeper account on an in-memory chain behind real viem public and wallet clients (custom transport): a geth-like
 * mempool (one transaction per nonce; a replacement needs +10% on both fee fields), blocks mined only when the test
 * calls `mine`. `onSend` runs for every transaction the node accepts; `failReceipts` makes receipt lookups fail.
 */
export function scriptedChain(
  opts: {
    onSend?: (hash: Hex, tx: Tx, chain: ScriptedChain) => void;
    /** A node error message to refuse `tx` with (before it enters the pool), or null to consider it. */
    refuse?: (tx: Tx) => string | null;
    /** Runs after the chain answered `method` (the answer is already computed). */
    onCall?: (method: string, params: unknown[], chain: ScriptedChain) => void;
    /** What eth_estimateGas answers (default 150,000). */
    estimateGas?: bigint;
  } = {},
) {
  const account = privateKeyToAccount(KEY);
  let head = 1_000n;
  let confirmed = 0;
  const txs = new Map<Hex, Tx>();
  const pool = new Map<number, Hex>();
  const minedIn = new Map<Hex, bigint>();
  const blocks = new Map<bigint, Hex[]>();
  const results = new Map<Hex, { status: 'success' | 'reverted'; logs: Log[] }>();
  /** Every transaction the node accepted, in order. */
  const accepted: Hex[] = [];
  /** Every transaction mined, in order. */
  const mined: Hex[] = [];
  /** RPC methods called, in order (eth_chainId and eth_blockNumber left out). */
  const calls: string[] = [];
  let receiptFailures = 0;
  let receiptLag = 0;
  let foreignCount = 0;

  const hex = (n: bigint | number) => toHex(BigInt(n));
  const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
  const txJson = (h: Hex) => {
    const t = txs.get(h)!;
    const b = minedIn.get(h);
    return {
      hash: h,
      from: account.address,
      to: t.to,
      nonce: hex(t.nonce),
      value: hex(t.value ?? 0n),
      input: t.data ?? '0x',
      gas: hex(t.gas ?? 0n),
      maxFeePerGas: hex(t.maxFeePerGas),
      maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas),
      gasPrice: hex(t.maxFeePerGas),
      type: '0x2',
      chainId: hex(testChain.id),
      accessList: [],
      blockHash: b === undefined ? null : blockHash(b),
      blockNumber: b === undefined ? null : hex(b),
      transactionIndex: b === undefined ? null : '0x0',
      v: '0x0',
      r: '0x1',
      s: '0x1',
      yParity: '0x0',
    };
  };
  const blockJson = (n: bigint, full: boolean) => ({
    number: hex(n),
    hash: blockHash(n),
    parentHash: blockHash(n - 1n),
    baseFeePerGas: hex(BASE_FEE),
    timestamp: hex(1_700_000_000n + n),
    gasLimit: hex(30_000_000),
    gasUsed: '0x0',
    miner: account.address,
    difficulty: '0x0',
    extraData: '0x',
    logsBloom: `0x${'00'.repeat(256)}`,
    nonce: '0x0000000000000000',
    receiptsRoot: `0x${'00'.repeat(32)}`,
    sha3Uncles: `0x${'00'.repeat(32)}`,
    size: '0x0',
    stateRoot: `0x${'00'.repeat(32)}`,
    totalDifficulty: '0x0',
    transactionsRoot: `0x${'00'.repeat(32)}`,
    uncles: [],
    mixHash: `0x${'00'.repeat(32)}`,
    transactions: (blocks.get(n) ?? []).map((h) => (full ? txJson(h) : h)),
  });
  const receiptJson = (h: Hex) => {
    const b = minedIn.get(h)!;
    const r = results.get(h) ?? { status: 'success', logs: [] };
    return {
      transactionHash: h,
      blockHash: blockHash(b),
      blockNumber: hex(b),
      transactionIndex: '0x0',
      from: account.address,
      to: txs.get(h)?.to ?? null,
      cumulativeGasUsed: hex(120_000),
      gasUsed: hex(120_000),
      effectiveGasPrice: hex(BASE_FEE),
      contractAddress: null,
      logs: r.logs.map((l, i) => ({
        ...l,
        blockHash: blockHash(b),
        blockNumber: hex(b),
        transactionHash: h,
        transactionIndex: '0x0',
        logIndex: hex(i),
        removed: false,
      })),
      logsBloom: `0x${'00'.repeat(256)}`,
      status: r.status === 'success' ? '0x1' : '0x0',
      type: '0x2',
    };
  };

  const ctl = {
    account,
    accepted,
    mined,
    calls,
    pool,
    get head() {
      return head;
    },
    get confirmed() {
      return confirmed;
    },
    nonceOf: (h: Hex) => txs.get(h)?.nonce,
    /** Calldata and gas limit of a transaction the node accepted. */
    dataOf: (h: Hex) => txs.get(h)?.data,
    gasOf: (h: Hex) => txs.get(h)?.gas,
    /** Mines `hash` (ours or foreign) in a new block; everything else at its nonce leaves the pool. */
    mine(h: Hex, result: { status?: 'success' | 'reverted'; logs?: Log[] } = {}) {
      const t = txs.get(h);
      if (!t) throw new Error(`unknown transaction ${h}`);
      head += 1n;
      blocks.set(head, [h]);
      minedIn.set(h, head);
      mined.push(h);
      results.set(h, { status: result.status ?? 'success', logs: result.logs ?? [] });
      confirmed = Math.max(confirmed, t.nonce + 1);
      for (const [n] of pool) if (n < confirmed) pool.delete(n);
    },
    /** Drops whatever is pending at `nonce` without mining it (mempool eviction during a fee spike). */
    evict(nonce: number) {
      pool.delete(nonce);
    },
    /** A transaction from the same key sent by someone else (a previous run, another process), pending at `nonce`. */
    foreign(nonce: number): Hex {
      const h = keccak256(toHex(`foreign-${nonce}-${++foreignCount}`));
      txs.set(h, { type: 'eip1559', chainId: testChain.id, nonce, to: account.address, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21_000n });
      pool.set(nonce, h);
      return h;
    },
    /** The next `n` receipt lookups fail like a rate-limited public RPC (-32005). */
    failReceipts(n: number) {
      receiptFailures = n;
    },
    /** The next `n` receipt lookups answer "not found" even for mined transactions (a replica behind the nonce count). */
    lagReceipts(n: number) {
      receiptLag = n;
    },
  };

  const answer = (method: string, p: unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return hex(testChain.id);
      case 'eth_blockNumber':
        return hex(head);
      case 'eth_estimateGas':
        return hex(opts.estimateGas ?? 150_000n);
      case 'eth_maxPriorityFeePerGas':
        return hex(1_000_000_000);
      case 'eth_gasPrice':
        return hex(BASE_FEE + 1_000_000_000n);
      case 'eth_getBlockByNumber': {
        const [tag, full] = p as [string, boolean];
        return blockJson(tag === 'latest' || tag === 'pending' || tag === 'finalized' || tag === 'safe' ? head : BigInt(tag), full);
      }
      case 'eth_getTransactionCount':
        return hex(p[1] === 'pending' ? Math.max(confirmed, ...[...pool.keys()].map((n) => n + 1)) : confirmed);
      case 'eth_sendRawTransaction': {
        const raw = p[0] as Hex;
        const t = parseTransaction(raw) as Tx;
        const h = keccak256(raw);
        if (t.nonce < confirmed) throw rpcError('nonce too low');
        if (pool.get(t.nonce) === h) throw rpcError('already known');
        const refusal = opts.refuse?.(t);
        if (refusal) throw rpcError(refusal);
        const cur = pool.get(t.nonce);
        if (cur) {
          const c = txs.get(cur)!;
          if (t.maxFeePerGas * 10n < c.maxFeePerGas * 11n || t.maxPriorityFeePerGas * 10n < c.maxPriorityFeePerGas * 11n)
            throw rpcError('replacement transaction underpriced');
        }
        txs.set(h, t);
        pool.set(t.nonce, h);
        accepted.push(h);
        opts.onSend?.(h, t, chain);
        return h;
      }
      case 'eth_getTransactionByHash': {
        const h = p[0] as Hex;
        return minedIn.has(h) || [...pool.values()].includes(h) ? txJson(h) : null;
      }
      case 'eth_getTransactionReceipt': {
        if (receiptFailures > 0) {
          receiptFailures -= 1;
          throw rpcError('request limit exceeded', -32_005);
        }
        const h = p[0] as Hex;
        if (receiptLag > 0) {
          receiptLag -= 1;
          return null;
        }
        return minedIn.has(h) ? receiptJson(h) : null;
      }
      default:
        throw new Error(`scripted chain: unexpected ${method}`);
    }
  };
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const p = (params ?? []) as unknown[];
        if (method !== 'eth_chainId' && method !== 'eth_blockNumber') calls.push(method);
        const result = answer(method, p);
        opts.onCall?.(method, p, chain);
        return result;
      },
    },
    { retryCount: 0 },
  );

  const client = createPublicClient({ chain: testChain, transport, pollingInterval: 5 }) as PublicClient;
  const wallet = createWalletClient({ account, chain: testChain, transport, pollingInterval: 5 }) as Wallet;
  // The callbacks above run only once requests flow, after this assignment.
  const chain = Object.assign(ctl, { client, wallet });
  return chain;
}
