import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from 'viem';
import { PRICE_KEYS, pTokenAbi, vaultManagerAbi, type PositionState, type ProtocolState } from '@mezodot/sdk';
import { READ_ONLY_SENDS, evaluateAccount } from '../src/liquidator';
import { StuckTransactionError, type SendOptions, type Settlement } from '../src/tx';

const E18 = 10n ** 18n;
const POOL_MUSD = '0x00000000000000000000000000000000000000a1';
const POOL_MEZO = '0x00000000000000000000000000000000000000a2';
const ALICE = '0x00000000000000000000000000000000000a11ce';

const market = (id: number, pool: `0x${string}`, symbol: 'MUSD' | 'MEZO') => ({
  id,
  symbol,
  receiptSymbol: `p${symbol}`,
  pool,
  asset: pool,
  decimals: 18,
  shareDecimals: 24,
  priceKey: PRICE_KEYS[symbol],
  totalAssets: 0n,
  totalBorrows: 0n,
  totalReserves: 0n,
  cash: 0n,
  totalSupply: 0n,
  exchangeRate: E18, // 1 share (1e24) = 1 underlying
  borrowRatePerSecond: 0n,
  supplyRatePerSecond: 0n,
  supplyCap: 0n,
  borrowCap: 0n,
  reserveFactor: 10n ** 17n,
});

const protocol: ProtocolState = {
  markets: [market(0, POOL_MUSD, 'MUSD'), market(1, POOL_MEZO, 'MEZO')],
  collaterals: [
    {
      id: 0,
      enabled: true,
      isRemote: false,
      isShare: true,
      token: POOL_MEZO,
      chainId: 0,
      remoteToken: '0x',
      decimals: 18,
      priceKey: PRICE_KEYS.MEZO,
      ltvBps: 5000,
      ltBps: 6000,
      bonusBps: 1000,
      cap: 0n,
      total: 0n,
      symbol: 'pMEZO',
    },
    {
      id: 1,
      enabled: true,
      isRemote: true,
      isShare: false,
      token: '0x0000000000000000000000000000000000000000',
      chainId: 10004,
      remoteToken: '0x',
      decimals: 18,
      priceKey: PRICE_KEYS.ETH,
      ltvBps: 7500,
      ltBps: 8000,
      bonusBps: 700,
      cap: 0n,
      total: 0n,
      symbol: 'WETH',
    },
  ],
  keeperCount: 0n,
  blockNumber: 0n,
  liquidationFeeBps: 0,
  treasury: '0x0000000000000000000000000000000000000000',
};

const position = (wethUnits: bigint, debtMusd: bigint, mezoShares = 0n): PositionState => ({
  account: ALICE,
  snapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: 0n, healthFactor: 0n },
  collateral: [
    { id: 0, balance: mezoShares, valueUsd: 0n },
    { id: 1, balance: wethUnits, valueUsd: 0n },
  ],
  debts: [
    { marketId: 0, amount: debtMusd },
    { marketId: 1, amount: 0n },
  ],
  isLeverageOperator: false,
  isSwapLeverageOperator: false,
});

describe('evaluateAccount', () => {
  it('healthy positions have no plan', () => {
    const e = evaluateAccount(protocol, position(E18, 2_000n * E18), { ETH: 3_200, MUSD: 1, MEZO: 0.008 });
    expect(e.healthFactor).toBeCloseTo((3_200 * 0.8) / 2_000, 9);
    expect(e.plan).toBeNull();
  });

  it('plans a 50% close-factor liquidation of remote wETH (CrossChain.t.sol numbers)', () => {
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1, MEZO: 0.008 });
    expect(e.healthFactor).toBeLessThan(1);
    expect(e.plan).not.toBeNull();
    const p = e.plan!;
    expect(p.collateralId).toBe(1);
    expect(p.isRemote).toBe(true);
    expect(p.repayAmount).toBe(1_175n * E18);
    expect(p.profitUsd).toBeCloseTo(1_175 * 0.07, 6);
    // minSeize = 98% of 1,175 × 1.07 / 2,800 wETH
    expect(Number(p.minSeize) / 1e18).toBeCloseTo(((1_175 * 1.07) / 2_800) * 0.98, 6);
  });

  it('leaves the protocol its share of the bonus out of the keeper profit', () => {
    // 10% of the 7% wETH bonus goes to the protocol: the keeper keeps 6.3% of the repaid value, less a rounding hair.
    const e = evaluateAccount({ ...protocol, liquidationFeeBps: 1_000 }, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1, MEZO: 0.008 });
    const p = e.plan!;
    expect(p.repayAmount).toBe(1_175n * E18);
    expect(p.profitUsd).toBeCloseTo(1_175 * 1.07 * (1 - 0.07 / 1.07 / 10) - 1_175, 6);
    // minSeize is based on what the keeper receives, so the contract's check passes.
    const received = (1_175 * 1.07 * (1 - 0.07 / 1.07 / 10)) / 2_800;
    expect(Number(p.minSeize) / 1e18).toBeLessThan(received);
    expect(Number(p.minSeize) / 1e18).toBeGreaterThan(received * 0.97);
  });

  it('caps repayment by keeper inventory', () => {
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1 }, { 0: 100n * E18 });
    expect(e.plan!.repayAmount).toBe(100n * E18);
  });

  it('scales down when collateral cannot cover the bonus', () => {
    const e = evaluateAccount(protocol, position(E18 / 10n, 2_350n * E18), { ETH: 2_800, MUSD: 1 });
    const p = e.plan!;
    expect(p.seizeUsd).toBeCloseTo(280, 6);
    expect(p.repayUsd).toBeCloseTo(280 / 1.07, 6);
  });

  it('values local pToken collateral via the exchange rate', () => {
    const shares = 1_000_000n * 10n ** 24n; // 1,000,000 MEZO worth of pMEZO
    const e = evaluateAccount(protocol, position(0n, 3_900n * E18, shares), { MEZO: 0.004764, MUSD: 1, ETH: 3_000 });
    expect(e.collateralUsd).toBeCloseTo(4_764, 6);
    expect(e.plan!.collateralId).toBe(0);
  });

  it('skips accounts when a price is unavailable', () => {
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { MUSD: 1 });
    expect(e.plan).toBeNull();
    expect(e.symbols).toEqual(['MUSD', 'ETH']);
    expect(e.unpriced).toEqual(['ETH']); // VaultManager prices liquidations strictly: it would revert
  });

  it('no plan when any held asset is unpriced, even if another pair looks profitable', () => {
    // pMEZO alone would be seizable, but the WETH price is missing: the strict valuation reverts.
    const shares = 6_000_000n * 10n ** 24n;
    const e = evaluateAccount(protocol, position(20n * E18, 55_000n * E18, shares), { MEZO: 0.004764, MUSD: 1 });
    expect(e.unpriced).toEqual(['ETH']);
    expect(e.plan).toBeNull();
  });
});

describe('mergeAccounts', () => {
  it('dedupes within a batch and across batches, case-insensitively', async () => {
    const { mergeAccounts } = await import('../src/liquidator');
    const a = '0x00000000000000000000000000000000000000Aa';
    const b = '0x00000000000000000000000000000000000000bb';
    expect(mergeAccounts([], [a, a.toLowerCase() as `0x${string}`, b, b])).toEqual([a, b]);
    expect(mergeAccounts([a], [a, b])).toEqual([a, b]);
  });
});

// --- keeper paths against fake chains -------------------------------------------------------------------------

const VAULT = '0x0000000000000000000000000000000000000001';
const GATEWAY = '0x0000000000000000000000000000000000000002';
const ROUTER_ORACLE = '0x0000000000000000000000000000000000000003';
const ADAPTER = '0x0000000000000000000000000000000000000004';
const TIGRIS_ROUTER = '0x0000000000000000000000000000000000000005';
const TIGRIS_FACTORY = '0x0000000000000000000000000000000000000006';
const TIGRIS_POOL = '0x0000000000000000000000000000000000000007';
const MUSD_TOKEN = '0x00000000000000000000000000000000000000c1';
const BTC_TOKEN = '0x7b7C000000000000000000000000000000000000'; // Mezo's BTC precompile: also the native gas coin
const KEEPER = '0x00000000000000000000000000000000000000ee';

type Call = { address?: string; functionName: string; args?: readonly unknown[] };

/**
 * Keeper sender double: records every request, reports it to `onBroadcast` like TxSender, and answers with a receipt
 * from `receiptFor` (or throws the error it returns). `settled` is what `settle` reports for anything sent earlier.
 */
function fakeSender(receiptFor: (request: Call) => Record<string, unknown> | Error = () => ({})) {
  const sent: Call[] = [];
  const sender = {
    address: KEEPER,
    settled: { status: 'pending' } as Settlement,
    settle: async () => sender.settled,
    send: async (request: Call, options?: SendOptions) => {
      sent.push(request);
      const nonce = sent.length - 1;
      const hash = `0x${String(sent.length).padStart(64, '0')}` as Hex;
      options?.onBroadcast?.({ network: 'devnet-hub', nonce, hashes: [hash] });
      const answer = receiptFor(request);
      if (answer instanceof Error) throw answer;
      return { hash, receipt: { status: 'success', logs: [], transactionHash: hash, ...answer }, gas: 0n, nonce };
    },
  };
  return { sender, sent };
}

const liquidatedLog = (seized: bigint, repaid: bigint, collateralId = 0n, account: Hex = ALICE) => ({
  address: VAULT,
  topics: encodeEventTopics({ abi: vaultManagerAbi, eventName: 'Liquidated', args: { account, liquidator: GATEWAY, marketId: 0n } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [collateralId, repaid, seized]),
});

/** What PToken.redeem emits: the shares burnt and the assets paid to the keeper. */
const withdrawLog = (pool: Hex, assets: bigint, shares: bigint) => ({
  address: pool,
  topics: encodeEventTopics({ abi: pTokenAbi, eventName: 'Withdraw', args: { sender: KEEPER, receiver: KEEPER, owner: KEEPER } }),
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [assets, shares]),
});

/** The debt asset a Tigris sale paid the keeper. */
const proceedsLog = (token: Hex, value: bigint) => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: TIGRIS_POOL, to: KEEPER } }),
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
});

/** The Ethereum Sepolia-like spoke WETH is released on (wormhole chain 10004), with its gas price. */
const wethSpoke = (gasPrice = 0n) => ({
  network: 'devnet-spoke',
  client: { getGasPrice: async () => gasPrice },
  deployment: { wormholeChainId: 10004, contracts: {} },
});

function keeperCtx(client: Record<string, unknown>, sender: unknown, config: Record<string, unknown> = {}, spokes: unknown[] = [wethSpoke()]) {
  return {
    config: {
      stateDir: mkdtempSync(join(tmpdir(), 'mezodot-liq-')),
      env: 'devnet',
      minProfitUsd: 1,
      unsellablePolicy: 'hold',
      maxSaleDiscountBps: 500,
      minGasBalance: {},
      ...config,
    },
    hub: {
      network: 'devnet-hub',
      client,
      wallet: { account: { address: KEEPER } },
      sender,
      deployment: {
        startBlock: 0,
        contracts: {
          vaultManager: VAULT,
          keeperGateway: GATEWAY,
          oracleRouter: ROUTER_ORACLE,
          wormholeAdapter: ADAPTER,
          tigrisRouter: TIGRIS_ROUTER,
          tigrisFactory: TIGRIS_FACTORY,
          tigrisPool: TIGRIS_POOL,
        },
        tokens: { MUSD: MUSD_TOKEN, MEZO: POOL_MEZO, BTC: BTC_TOKEN },
      },
    },
    spokes,
    log: () => {},
  };
}

/** MUSD debt, BTC plain collateral (5% bonus, 10% of it to the protocol), as on the v4 hub. */
const btcProtocol: ProtocolState = {
  ...protocol,
  markets: [{ ...market(0, POOL_MUSD, 'MUSD'), asset: MUSD_TOKEN }],
  collaterals: [
    {
      id: 0,
      enabled: true,
      isRemote: false,
      isShare: false,
      token: BTC_TOKEN,
      chainId: 0,
      remoteToken: '0x',
      decimals: 18,
      priceKey: PRICE_KEYS.BTC,
      ltvBps: 7000,
      ltBps: 7800,
      bonusBps: 500,
      cap: 0n,
      total: 0n,
      symbol: 'BTC',
    },
  ],
  liquidationFeeBps: 1_000,
};
const btcPosition = (btc: bigint, debt: bigint): PositionState => ({
  account: ALICE,
  snapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: 0n, healthFactor: 0n },
  collateral: [{ id: 0, balance: btc, valueUsd: 0n }],
  debts: [{ marketId: 0, amount: debt }],
  isLeverageOperator: false,
  isSwapLeverageOperator: false,
});
const BTC_PRICES = { BTC: 80_000, MUSD: 1 };

/** Hub reads for a BTC liquidation: Tigris pays `poolPrice` MUSD per BTC; tiny gas price. */
const btcClient = (poolPrice: number, extra: Record<string, (c: Call) => unknown> = {}) => ({
  getGasPrice: async () => 10n,
  getBalance: async () => 10n ** 18n,
  readContract: async (c: Call) => {
    if (extra[c.functionName]) return extra[c.functionName](c);
    if (c.functionName === 'getAmountOut') return BigInt(Math.floor((Number(c.args![0]) / 1e18) * poolPrice * 1e6)) * 10n ** 12n;
    if (c.functionName === 'allowance') return 10n ** 30n;
    if (c.functionName === 'balanceOf') return 10n ** 24n;
    return 0n;
  },
  simulateContract: async () => ({ result: 4n * 10n ** 17n, request: { address: GATEWAY, functionName: 'triggerLiquidation', args: [] } }),
});

describe('liquidator against RPC limits and fees (final review I4 / M3 / M8)', () => {
  it('picks the most profitable collateral, not the largest', () => {
    // WETH is the largest collateral ($40,000, 7% bonus) but pMEZO ($28,584, 10% bonus) pays more:
    // repay 27,500 → pMEZO seize scaled to all $28,584 → profit $2,598.5; WETH profit $1,925.
    const shares = 6_000_000n * 10n ** 24n;
    const e = evaluateAccount(protocol, position(20n * E18, 55_000n * E18, shares), { MEZO: 0.004764, MUSD: 1, ETH: 2_000 });
    expect(e.healthFactor).toBeLessThan(1);
    expect(e.plan!.collateralId).toBe(0);
    expect(e.plan!.profitUsd).toBeCloseTo(28_584 * (1 - 1 / 1.1), 4);
  });

  it('indexes borrowers in chunks under the RPC block-range cap, advancing the cursor', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const borrowAt = new Map<bigint, `0x${string}`>([
      [3n, '0x00000000000000000000000000000000000000a1'],
      [14_000n, '0x00000000000000000000000000000000000000b2'],
      [24_999n, '0x00000000000000000000000000000000000000c3'],
    ]);
    const calls: [bigint, bigint][] = [];
    const client = {
      getBlockNumber: async () => 25_000n,
      getContractEvents: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        if (toBlock - fromBlock >= 10_000n) throw new Error('maximum [from, to] blocks distance: 10000');
        calls.push([fromBlock, toBlock]);
        return [...borrowAt].filter(([b]) => b >= fromBlock && b <= toBlock).map(([, account]) => ({ args: { account } }));
      },
    };
    const liq = new Liquidator(keeperCtx(client, null) as never);
    const accounts = await liq.syncAccounts();
    expect(accounts).toHaveLength(3);
    expect(calls.length).toBeGreaterThan(2);
    expect(liq.store.get().cursor).toBe(25_001n);
    expect(liq.store.get().vaultManager).toBe(VAULT);
    // The next sync re-reads a few blocks below the cursor, in case a replica served the last window incompletely.
    calls.length = 0;
    await liq.syncAccounts();
    expect(calls[0][0]).toBe(25_001n - 20n);
  });

  it('values with the prices a liquidation will post, not an outdated stored pull price', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const leg = (source: number, usable: boolean, price: bigint) => ({ source, maxAge: 120, id: '0x13' as const, price, conf: 0n, publishTime: 0, usable });
    const status = (symbol: string, legs: ReturnType<typeof leg>[], price: bigint) => ({
      symbol,
      feed: { primary: legs[0], secondary: legs[1] ?? null, maxConfBps: 200, maxDivergenceBps: 150 },
      ok: true,
      price,
      validUntil: 0,
      lastPrice: price,
      publishTime: 0,
      legs,
    });
    // Stored Supra ETH is still fresh at $3,200 but the latest proof says $2,800 (Pyth ETH never pushed).
    const oracle = {
      MUSD: status('MUSD', [leg(1, true, E18)], E18),
      MEZO: status('MEZO', [leg(1, true, E18 / 100n)], E18 / 100n),
      ETH: status('ETH', [leg(1, false, 0n), leg(2, true, 3_200n * E18)], 3_200n * E18),
      USDC: status('USDC', [leg(1, true, E18), leg(2, false, 0n)], E18),
      BTC: status('BTC', [leg(1, true, 80_000n * E18), leg(2, false, 0n)], 80_000n * E18),
    };
    const asked: string[][] = [];
    const relay = {
      oracle: async () => oracle,
      update: async (symbols: string[]) => (
        asked.push(symbols),
        { updates: ['0x02aa'], prices: { ETH: { price: 2_800, publishTime: 1, source: 'supra' } }, missing: [] }
      ),
    };
    const ctx = keeperCtx({}, null, { env: 'testnet' });
    const liq = new Liquidator(ctx as never, relay as never);
    const { prices, updates } = await liq.keeperPricing(['MUSD', 'ETH']);
    expect(asked).toEqual([['ETH']]); // MUSD is a Pyth push feed on testnet: nothing to pull
    expect(prices.ETH).toBe(2_800);
    expect(updates).toEqual(['0x02aa']);
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), prices);
    expect(e.healthFactor).toBeLessThan(1); // at the stored $3,200 it would look healthy (HF 1.09)
    expect(e.plan).not.toBeNull();
  });

  it('pays the Wormhole message fee when seizing remote collateral', async () => {
    const { Liquidator } = await import('../src/liquidator');
    let simulatedValue: bigint | undefined;
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'updateFee' ? 4n : functionName === 'messageFee' ? 1_000n : functionName === 'allowance' ? 10n ** 30n : 0n,
      simulateContract: async ({ value }: { value: bigint }) => {
        simulatedValue = value;
        return { result: 1n, request: {} };
      },
    };
    const liq = new Liquidator(keeperCtx(client, fakeSender().sender) as never);
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1 });
    await liq.execute(protocol, e, ['0x01'], true);
    expect(simulatedValue).toBe(4n + 1_000n);
    const local = evaluateAccount(protocol, position(0n, 3_900n * E18, 1_000_000n * 10n ** 24n), { MEZO: 0.004764, MUSD: 1, ETH: 3_000 });
    await liq.execute(protocol, local, ['0x01'], true);
    expect(simulatedValue).toBe(4n);
  });
});

describe('keeper liveness (audit r2-keeper-liveness)', () => {
  it('drops borrowers that no longer owe anything (a new Borrowed event re-adds them)', async () => {
    const { activeBorrowers } = await import('../src/liquidator');
    const owing = position(E18, 1n);
    const repaid = { ...position(E18, 0n), account: '0x00000000000000000000000000000000000000b0' as const };
    expect(activeBorrowers([owing, repaid])).toEqual([ALICE]);
  });

  it('drops a borrower only after several debt-free reads in a row (a lagging replica can report 0 once)', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const liq = new Liquidator(keeperCtx({}, null) as never);
    liq.store.update((s) => void (s.accounts = [ALICE]));
    const dropRepaid = (ps: PositionState[]) => (liq as unknown as { dropRepaid: (p: PositionState[]) => void }).dropRepaid(ps);
    dropRepaid([position(E18, 0n)]);
    dropRepaid([position(E18, 5n)]); // owes again: the count restarts
    dropRepaid([position(E18, 0n)]);
    dropRepaid([position(E18, 0n)]);
    expect(liq.store.get().accounts).toEqual([ALICE]);
    dropRepaid([position(E18, 0n)]);
    expect(liq.store.get().accounts).toEqual([]);
  });

  it('orders liquidatable accounts by the debt their collateral no longer covers', async () => {
    const { byShortfall } = await import('../src/liquidator');
    const e = (account: string, debtUsd: number, adjustedUsd: number) => ({ account, debtUsd, adjustedUsd }) as never;
    const sorted = [e('small', 100, 95), e('big', 10_000, 9_000), e('mid', 1_000, 900)].sort(byShortfall);
    expect(sorted.map((x: { account: string }) => x.account)).toEqual(['big', 'mid', 'small']);
  });
});

/** The fixture with pMUSD instead of pMEZO as collateral 0: a pToken of the MUSD debt itself. */
const pMusdProtocol: ProtocolState = {
  ...protocol,
  collaterals: [{ ...protocol.collaterals[0], token: POOL_MUSD, priceKey: PRICE_KEYS.MUSD, symbol: 'pMUSD' }, protocol.collaterals[1]],
};

describe('recycling seized collateral (inventory-recycling)', () => {
  const pMusdLiquidation = () => evaluateAccount(pMusdProtocol, position(0n, 3_900n * E18, 4_000n * 10n ** 24n), { MEZO: 0.004764, MUSD: 1, ETH: 3_000 });

  it('redeems what the receipt says was seized, not what the earlier simulation returned', async () => {
    const { Liquidator } = await import('../src/liquidator');
    // Interest accrued between the eth_call and the block: 123 shares simulated, 100 actually seized.
    const { sender, sent } = fakeSender((r) => (r.functionName === 'triggerLiquidation' ? { logs: [liquidatedLog(100n, 1_950n * E18)] } : {}));
    const client = {
      readContract: async ({ functionName }: Call) =>
        functionName === 'allowance' ? 10n ** 30n : functionName === 'maxRedeem' || functionName === 'balanceOf' ? 10n ** 30n : 0n,
      simulateContract: async () => ({ result: 123n, request: { functionName: 'triggerLiquidation', address: GATEWAY, args: [] } }),
    };
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    const out = await liq.execute(pMusdProtocol, pMusdLiquidation(), []);
    expect(out.seized).toBe(100n);
    expect(sent.map((w) => w.functionName)).toEqual(['triggerLiquidation', 'redeem']);
    expect(sent[1].address).toBe(POOL_MUSD);
    expect(sent[1].args).toEqual([100n, KEEPER, KEEPER]);
    expect(liq.held()).toEqual([]);
    expect(liq.pendingTransactions()).toEqual([]); // both settled by their receipts
  });

  it('redeems only what the pool can pay out now and converts the rest on later ticks', async () => {
    const { Liquidator } = await import('../src/liquidator');
    let maxRedeem = 40n;
    const { sender, sent } = fakeSender((r) => (r.functionName === 'triggerLiquidation' ? { logs: [liquidatedLog(100n, 1_950n * E18)] } : {}));
    const client = {
      readContract: async ({ functionName }: Call) =>
        functionName === 'maxRedeem' ? maxRedeem : functionName === 'balanceOf' ? 100n : functionName === 'allowance' ? 10n ** 30n : 0n,
      simulateContract: async () => ({ result: 100n, request: { functionName: 'triggerLiquidation', address: GATEWAY, args: [] } }),
    };
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    await liq.execute(pMusdProtocol, pMusdLiquidation(), []);
    expect(sent[1].args).toEqual([40n, KEEPER, KEEPER]);
    expect(liq.held()).toMatchObject([{ collateralId: 0, marketId: 0, amount: 60n }]);
    // Persisted: a restart still knows about it.
    const again = new Liquidator(
      keeperCtx(client, sender, { stateDir: (liq.store as unknown as { path: string }).path.replace(/\/[^/]+$/, '') }) as never,
      {} as never,
    );
    expect(again.held()).toMatchObject([{ amount: 60n }]);
    maxRedeem = 0n;
    await liq.convertHeld(pMusdProtocol, {});
    expect(sent).toHaveLength(2); // no idle cash: nothing sent
    maxRedeem = 10n ** 30n;
    await liq.convertHeld(pMusdProtocol, {});
    expect(sent[2].args).toEqual([60n, KEEPER, KEEPER]);
    expect(liq.held()).toEqual([]);
  });

  it('remote seizures are paid on the spoke: nothing to convert on the hub; a reverted liquidation is an error', async () => {
    const { Liquidator } = await import('../src/liquidator');
    let status = 'success';
    const { sender, sent } = fakeSender(() => ({ status, logs: [liquidatedLog(4n * 10n ** 17n, 1_175n * E18, 1n)] }));
    const client = {
      readContract: async ({ functionName }: Call) => (functionName === 'allowance' ? 10n ** 30n : 0n),
      simulateContract: async () => ({ result: 1n, request: { functionName: 'triggerLiquidation', address: GATEWAY, args: [] } }),
    };
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    const remote = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1 });
    await liq.execute(protocol, remote, []);
    expect(sent.map((w) => w.functionName)).toEqual(['triggerLiquidation']);
    expect(liq.held()).toEqual([]);
    status = 'reverted';
    await expect(liq.execute(protocol, remote, [])).rejects.toThrow(/reverted/);
    expect(liq.pendingTransactions()).toEqual([]);
  });
});

describe('BTC liquidations priced at the Tigris sale (liq-profit-oracle-only, btc-liquidation-unprofitable)', () => {
  const unhealthy = () => evaluateAccount(btcProtocol, btcPosition(E18, 63_000n * E18), BTC_PRICES);

  it('plans at oracle prices, keeping 4.5% after the protocol fee', () => {
    const e = unhealthy();
    expect(e.healthFactor).toBeCloseTo((80_000 * 0.78) / 63_000, 9);
    expect(e.plan!.repayAmount).toBe(31_500n * E18);
    expect(e.plan!.profitUsd).toBeCloseTo(31_500 * 0.045, 6);
  });

  it('sells right away when Tigris pays back the repayment with profit', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const liq = new Liquidator(keeperCtx(btcClient(80_000), fakeSender().sender) as never, {} as never);
    const a = await liq.assess(btcProtocol, unhealthy(), BTC_PRICES, []);
    expect(a).toMatchObject({ action: 'liquidate', sale: 'sell' });
    // 98% of the quote (slippage) less the repayment: 32,917.5 × 0.98 − 31,500.
    expect(a.netProfitUsd).toBeCloseTo(32_917.5 * 0.98 - 31_500, 0);
  });

  it('holds the BTC when the live testnet gap (Tigris 5% below the oracle) would turn the sale into a loss', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const liq = new Liquidator(keeperCtx(btcClient(76_000), fakeSender().sender) as never, {} as never);
    const a = await liq.assess(btcProtocol, unhealthy(), BTC_PRICES, []);
    expect(a.oracleProfitUsd).toBeCloseTo(1_417.5, 6);
    expect(a).toMatchObject({ action: 'liquidate', sale: 'hold' });
    expect(a.reason).toMatch(/Tigris pays .* MUSD for the seized BTC/);
    expect(Number(a.saleQuote)).toBeCloseTo(32_917.5 * 0.95, 0);
  });

  it('skips instead with LIQUIDATE_UNSELLABLE=skip, and when there is no quote at all', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const skip = new Liquidator(keeperCtx(btcClient(76_000), fakeSender().sender, { unsellablePolicy: 'skip' }) as never, {} as never);
    expect(await skip.assess(btcProtocol, unhealthy(), BTC_PRICES, [])).toMatchObject({ action: 'skip', sale: null });
    const noPool = btcClient(80_000, {
      getAmountOut: () => {
        throw new Error('execution reverted');
      },
    });
    const none = new Liquidator(keeperCtx(noPool, fakeSender().sender, { unsellablePolicy: 'skip' }) as never, {} as never);
    expect(await none.assess(btcProtocol, unhealthy(), BTC_PRICES, [])).toMatchObject({ action: 'skip', reason: expect.stringMatching(/no Tigris quote/) });
  });

  it('counts gas, the oracle update fee and the Wormhole fee against the profit', async () => {
    const { Liquidator } = await import('../src/liquidator');
    // 1 gwei-ish BTC gas at $80,000 per BTC: a Supra-proof liquidation plus approve and swap costs real money.
    const client = btcClient(80_000, { updateFee: () => 10n ** 13n });
    (client as { getGasPrice: () => Promise<bigint> }).getGasPrice = async () => 10n ** 10n;
    const liq = new Liquidator(keeperCtx(client, fakeSender().sender) as never, {} as never);
    const supraUpdate = '0x02aa' as const;
    const a = await liq.assess(btcProtocol, unhealthy(), BTC_PRICES, [supraUpdate]);
    const gas = 1_200_000 + 80_000 + 250_000;
    expect(a.costsUsd).toBeCloseTo(((gas * 1e10 + 1e13) / 1e18) * 80_000, 6);
  });

  it('takes spoke collateral below the oracle value: it still has to be realised on the spoke', async () => {
    const { Liquidator, REMOTE_REALISATION_HAIRCUT_BPS } = await import('../src/liquidator');
    const client = { getGasPrice: async () => 0n, readContract: async () => 0n };
    const liq = new Liquidator(keeperCtx(client, fakeSender().sender) as never, {} as never);
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1 });
    const a = await liq.assess(protocol, e, { ETH: 2_800, MUSD: 1 }, []);
    expect(a.action).toBe('liquidate');
    expect(a.netProfitUsd).toBeCloseTo(e.plan!.profitUsd - (e.plan!.seizeUsd * REMOTE_REALISATION_HAIRCUT_BPS) / 10_000, 6);
  });

  it('sells held BTC with a minimum bounded by the oracle, and keeps it while Tigris pays too little', async () => {
    const { Liquidator } = await import('../src/liquidator');
    let poolPrice = 70_000;
    const client = btcClient(0, {
      getAmountOut: (c) => BigInt(Math.floor((Number(c.args![0]) / 1e18) * poolPrice)) * 10n ** 18n,
      allowance: () => 0n,
      balanceOf: (c) => (c.address === BTC_TOKEN ? 4n * 10n ** 17n : 0n),
    });
    const { sender, sent } = fakeSender();
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    liq.store.update((s) => {
      s.held['0:0'] = { collateralId: 0, marketId: 0, amount: 4n * 10n ** 17n, cost: 31_500n * E18, minProceeds: 0n, since: 0, lastTx: '0x01' };
    });
    // 0.4 BTC is worth 32,000 MUSD at the oracle; 5% below that is 30,400: a 28,000 quote is refused.
    await liq.convertHeld(btcProtocol, BTC_PRICES);
    expect(sent).toEqual([]);
    expect(liq.held()).toHaveLength(1);

    poolPrice = 79_000; // 31,600 MUSD: within 5% of the oracle
    await liq.convertHeld(btcProtocol, BTC_PRICES);
    expect(sent.map((w) => w.functionName)).toEqual(['approve', 'swapExactTokensForTokens']);
    const [amountIn, minOut] = sent[1].args as [bigint, bigint];
    expect(amountIn).toBe(4n * 10n ** 17n);
    expect(minOut).toBeGreaterThanOrEqual(30_400n * E18); // the oracle bound, not just 98% of whatever Tigris quotes
    expect(liq.held()).toEqual([]);
  });

  it('never sells below what was repaid for BTC held by policy, and never the keeper gas', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const client = btcClient(80_000, { allowance: () => 10n ** 30n, balanceOf: () => 10n ** 18n });
    // 0.0003 BTC of native balance: only what is above twice the 0.0001 BTC gas minimum may be sold.
    (client as { getBalance: () => Promise<bigint> }).getBalance = async () => 3n * 10n ** 14n;
    const { sender, sent } = fakeSender();
    const ctx = keeperCtx(client, sender, { minGasBalance: { 'devnet-hub': 10n ** 14n } });
    const liq = new Liquidator(ctx as never, {} as never);
    liq.store.update((s) => {
      s.held['0:0'] = { collateralId: 0, marketId: 0, amount: 4n * 10n ** 17n, cost: 31_500n * E18, minProceeds: 31_500n * E18, since: 0, lastTx: '0x01' };
    });
    await liq.convertHeld(btcProtocol, BTC_PRICES);
    const [amountIn, minOut] = sent.find((w) => w.functionName === 'swapExactTokensForTokens')!.args as [bigint, bigint];
    expect(amountIn).toBe(10n ** 14n); // 0.0003 − 2 × 0.0001
    // Pro rata share of the repaid cost for the part sold.
    expect(minOut).toBeGreaterThanOrEqual((31_500n * E18 * 10n ** 14n) / (4n * 10n ** 17n));
    expect(liq.held()[0].amount).toBe(4n * 10n ** 17n - 10n ** 14n);
  });
});

describe('liquidator after a redeploy (redeploy-agent-cursor-skip)', () => {
  it('re-indexes from the new start block and archives the old borrowers and held collateral', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const dir = mkdtempSync(join(tmpdir(), 'mezodot-liq-'));
    writeFileSync(
      join(dir, 'liquidator-devnet.json'),
      JSON.stringify({ cursor: { $bigint: '16225251' }, accounts: [ALICE] }), // an older file: no VaultManager recorded
    );
    const liq = new Liquidator(keeperCtx({}, null, { stateDir: dir }) as never);
    expect(liq.store.get()).toMatchObject({ vaultManager: VAULT, cursor: null, accounts: [], held: {} });
    const archive = JSON.parse(readFileSync(join(dir, 'liquidator-devnet.archived.json'), 'utf8'));
    expect(archive).toMatchObject([{ reason: 'deployment replaced', vaultManager: null, accounts: [ALICE] }]);
  });

  it('keeps the index of its own VaultManager', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const dir = mkdtempSync(join(tmpdir(), 'mezodot-liq-'));
    writeFileSync(join(dir, 'liquidator-devnet.json'), JSON.stringify({ vaultManager: VAULT, cursor: { $bigint: '42' }, accounts: [ALICE], held: {} }));
    const liq = new Liquidator(keeperCtx({}, null, { stateDir: dir }) as never);
    expect(liq.store.get()).toMatchObject({ cursor: 42n, accounts: [ALICE] });
    expect(existsSync(join(dir, 'liquidator-devnet.archived.json'))).toBe(false);
  });
});

// --- final review A1 / A2 / A3 / A4 / A9 / A10 ---------------------------------------------------------------------

const MEZO_TOKEN = '0x00000000000000000000000000000000000000c2';
/** MUSD debt against pMEZO, whose pool pays out MEZO: pTokens of another asset than the debt. */
const crossProtocol: ProtocolState = {
  ...protocol,
  markets: [
    { ...market(0, POOL_MUSD, 'MUSD'), asset: MUSD_TOKEN },
    { ...market(1, POOL_MEZO, 'MEZO'), asset: MEZO_TOKEN },
  ],
};
const MEZO_PRICES = { MEZO: 0.004764, MUSD: 1, ETH: 3_000 };
/** 1,000,000 MEZO of pMEZO against 3,900 MUSD: repay 1,950, seize 2,145 MUSD of MEZO (450,251 MEZO). */
const pMezoForMusd = () => evaluateAccount(crossProtocol, position(0n, 3_900n * E18, 1_000_000n * 10n ** 24n), MEZO_PRICES);

/** Hub reads for the pMEZO pool and a Tigris MEZO → MUSD route paying `mezoPrice` MUSD per MEZO. */
const mezoClient = (mezoPrice: number, balances: Record<string, bigint> = {}) => ({
  getGasPrice: async () => 0n,
  getBalance: async () => 0n,
  readContract: async (c: Call) => {
    if (c.functionName === 'getAmountsOut') {
      const amount = c.args![0] as bigint;
      return [amount, (amount * BigInt(Math.round(mezoPrice * 1e9))) / 10n ** 9n];
    }
    if (c.functionName === 'maxRedeem') return 10n ** 40n;
    if (c.functionName === 'balanceOf') return balances[c.address!.toLowerCase()] ?? 0n;
    return 0n;
  },
  simulateContract: async () => ({ result: 1n, request: { functionName: 'triggerLiquidation', address: GATEWAY, args: [] } }),
});

describe('only receipts of a liquidation count as one (final review A1)', () => {
  it('a successful receipt without a Liquidated event seized nothing: nothing is held, no keeper BTC is sold', async () => {
    const { Liquidator } = await import('../src/liquidator');
    // E.g. the receipt of another transaction mined at the liquidation's nonce: status success, no Liquidated event.
    const { sender, sent } = fakeSender();
    const liq = new Liquidator(keeperCtx(btcClient(80_000), sender) as never, {} as never);
    const e = evaluateAccount(btcProtocol, btcPosition(E18, 63_000n * E18), BTC_PRICES);
    await expect(liq.execute(btcProtocol, e, [])).rejects.toThrow(/no Liquidated event/);
    expect(liq.held()).toEqual([]);
    expect(sent.map((w) => w.functionName)).toEqual(['triggerLiquidation']);
  });
});

describe('liquidator transactions are settled from chain state (final review A2)', () => {
  const client = {
    readContract: async ({ functionName }: Call) =>
      functionName === 'allowance' || functionName === 'maxRedeem' || functionName === 'balanceOf' ? 10n ** 30n : 0n,
    simulateContract: async () => ({ result: 123n, request: { functionName: 'triggerLiquidation', address: GATEWAY, args: [] } }),
  };
  const pMusdLiquidation = () => evaluateAccount(pMusdProtocol, position(0n, 3_900n * E18, 4_000n * 10n ** 24n), { MUSD: 1, MEZO: 0.004764, ETH: 3_000 });
  const stuck = () => new StuckTransactionError('devnet-hub', 0, [`0x${'01'.padStart(64, '0')}`]);
  const dirOf = (liq: { store: unknown }) => (liq.store as { path: string }).path.replace(/\/[^/]+$/, '');

  it('records a liquidation before it is sent, and applies its receipt once found, also after a restart', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const { sender, sent } = fakeSender((r) => (r.functionName === 'triggerLiquidation' ? stuck() : {}));
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    await expect(liq.execute(pMusdProtocol, pMusdLiquidation(), [])).rejects.toBeInstanceOf(StuckTransactionError);
    expect(liq.held()).toEqual([]);
    expect(liq.pendingTransactions()).toMatchObject([{ action: { type: 'liquidation', account: ALICE, collateralId: 0, marketId: 0 }, nonce: 0 }]);

    // The agent restarts (a shutdown cut the wait short); the liquidation was mined after all.
    const after = new Liquidator(keeperCtx(client, sender, { stateDir: dirOf(liq) }) as never, {} as never);
    sender.settled = { status: 'mined', receipt: { status: 'success', transactionHash: sent[0] as never, logs: [liquidatedLog(100n, 1_950n * E18)] } as never };
    await after.settlePending();
    expect(after.held()).toMatchObject([{ collateralId: 0, marketId: 0, amount: 100n, cost: 1_950n * E18 }]);
    expect(after.pendingTransactions()).toEqual([]);
  });

  it('never sells a lot again while its sale may still be mined, and releases it once the sale is found', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const { sender, sent } = fakeSender((r) => (r.functionName === 'swapExactTokensForTokens' ? stuck() : {}));
    const liq = new Liquidator(keeperCtx(btcClient(80_000), sender) as never, {} as never);
    liq.store.update((s) => {
      s.held['0:0'] = { collateralId: 0, marketId: 0, amount: 4n * 10n ** 17n, cost: 31_500n * E18, minProceeds: 0n, since: 0, lastTx: '0x01' };
    });
    const swaps = () => sent.filter((w) => w.functionName === 'swapExactTokensForTokens').length;
    await liq.convertHeld(btcProtocol, BTC_PRICES); // broadcast, then unmined through every fee bump
    expect(swaps()).toBe(1);
    expect(liq.held()[0].amount).toBe(4n * 10n ** 17n);
    await liq.convertHeld(btcProtocol, BTC_PRICES); // still pending: the keeper's own BTC is not sold as this lot
    expect(swaps()).toBe(1);
    sender.settled = { status: 'mined', receipt: { status: 'success', transactionHash: `0x${'02'.repeat(32)}`, logs: [] } as never };
    await liq.convertHeld(btcProtocol, BTC_PRICES);
    expect(liq.held()).toEqual([]);
    expect(swaps()).toBe(1);
    expect(liq.pendingTransactions()).toEqual([]);
  });

  it('drops a record once another transaction has held its nonce for a minute, then converts the lot again', async () => {
    const { Liquidator } = await import('../src/liquidator');
    let fail = true;
    const { sender, sent } = fakeSender((r) => (r.functionName === 'swapExactTokensForTokens' && fail ? stuck() : {}));
    const liq = new Liquidator(keeperCtx(btcClient(80_000), sender) as never, {} as never);
    liq.store.update((s) => {
      s.held['0:0'] = { collateralId: 0, marketId: 0, amount: 4n * 10n ** 17n, cost: 31_500n * E18, minProceeds: 0n, since: 0, lastTx: '0x01' };
    });
    const swaps = () => sent.filter((w) => w.functionName === 'swapExactTokensForTokens').length;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await liq.convertHeld(btcProtocol, BTC_PRICES);
      sender.settled = { status: 'dropped' };
      await liq.convertHeld(btcProtocol, BTC_PRICES); // first seen dropped: a lagging receipt endpoint is not trusted yet
      expect([swaps(), liq.pendingTransactions().length]).toEqual([1, 1]);
      vi.setSystemTime(Date.now() + 61_000);
      fail = false;
      await liq.convertHeld(btcProtocol, BTC_PRICES); // it never happened: the lot is sold for real now
      expect(swaps()).toBe(2);
      expect(liq.held()).toEqual([]);
      expect(liq.pendingTransactions()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a send the node refused leaves no record', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const { sender } = fakeSender((r) => (r.functionName === 'triggerLiquidation' ? new Error('insufficient funds for gas * price + value') : {}));
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    await expect(liq.execute(pMusdProtocol, pMusdLiquidation(), [])).rejects.toThrow(/insufficient funds/);
    expect(liq.pendingTransactions()).toEqual([]);
  });
});

describe('a process that follows the agent state read-only (final review A3)', () => {
  it('never sends keeper transactions, but still dry-runs them', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const { sender, sent } = fakeSender();
    const client = {
      readContract: async ({ functionName }: Call) => (functionName === 'allowance' ? 0n : 0n),
      simulateContract: async () => ({ result: 42n, request: { functionName: 'triggerLiquidation', address: GATEWAY, args: [] } }),
    };
    const liq = new Liquidator(keeperCtx(client, sender, { stateReadOnly: true }) as never, {} as never);
    const e = evaluateAccount(pMusdProtocol, position(0n, 3_900n * E18, 4_000n * 10n ** 24n), { MUSD: 1, MEZO: 0.004764, ETH: 3_000 });
    await expect(liq.execute(pMusdProtocol, e, [])).rejects.toThrow(READ_ONLY_SENDS);
    expect(sent).toEqual([]); // not even the approve
    expect(await liq.execute(pMusdProtocol, e, [], true)).toMatchObject({ simulated: 42n, txHash: null });
  });
});

describe('pTokens of another asset than the debt (final review A4)', () => {
  it('values seized pMEZO for MUSD debt at what its MEZO sells for, not at par', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const e = pMezoForMusd();
    expect(e.plan!.collateralId).toBe(0);
    // Tigris pays 0.0040 MUSD per MEZO, 16% below the oracle: 450,251 MEZO return ~1,801 MUSD for 1,950 repaid.
    const hold = await new Liquidator(keeperCtx(mezoClient(0.004), fakeSender().sender) as never, {} as never).assess(crossProtocol, e, MEZO_PRICES, []);
    expect(hold).toMatchObject({ action: 'liquidate', sale: 'hold' });
    expect(hold.reason).toMatch(/Tigris pays .* MUSD for the MEZO redeemed from the seized pMEZO/);
    expect(Number(hold.saleQuote)).toBeCloseTo(450_251 * 0.004, -1);
    const skip = new Liquidator(keeperCtx(mezoClient(0.004), fakeSender().sender, { unsellablePolicy: 'skip' }) as never, {} as never);
    expect(await skip.assess(crossProtocol, e, MEZO_PRICES, [])).toMatchObject({ action: 'skip', sale: null });
    // At the oracle price the sale pays back the repayment with profit: liquidate and sell.
    const sell = await new Liquidator(keeperCtx(mezoClient(0.004764), fakeSender().sender) as never, {} as never).assess(crossProtocol, e, MEZO_PRICES, []);
    expect(sell).toMatchObject({ action: 'liquidate', sale: 'sell' });
    expect(sell.netProfitUsd).toBeCloseTo(2_145 * 0.98 - 1_950, 0);
  });

  it('redeems seized pMEZO and sells the MEZO for MUSD with an oracle-bounded minimum', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const shares = 450_000n * 10n ** 24n;
    const mezo = 450_000n * E18;
    const { sender, sent } = fakeSender((r) =>
      r.functionName === 'redeem'
        ? { logs: [withdrawLog(POOL_MEZO, mezo, shares)] }
        : r.functionName === 'swapExactTokensForTokens'
          ? { logs: [proceedsLog(MUSD_TOKEN, 2_100n * E18)] }
          : {},
    );
    const client = mezoClient(0.004764, { [POOL_MEZO]: shares, [MEZO_TOKEN]: mezo });
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    liq.store.update((s) => {
      s.held['0:0'] = { collateralId: 0, marketId: 0, amount: shares, cost: 1_950n * E18, minProceeds: 0n, since: 0, lastTx: '0x01' };
    });
    await liq.convertHeld(crossProtocol, MEZO_PRICES);
    expect(sent.map((w) => w.functionName)).toEqual(['redeem', 'approve', 'swapExactTokensForTokens']);
    expect(sent[0]).toMatchObject({ address: POOL_MEZO, args: [shares, KEEPER, KEEPER] });
    const [amountIn, minOut, routes] = sent[2].args as [bigint, bigint, { from: string; to: string }[]];
    expect(amountIn).toBe(mezo);
    expect(routes[0]).toMatchObject({ from: MEZO_TOKEN, to: MUSD_TOKEN });
    // 450,000 MEZO are worth 2,143.8 MUSD at the oracle; the sale must return at least 95% of that.
    expect(minOut).toBeGreaterThanOrEqual((2_143_800n * E18 * 95n) / 100_000n);
    expect(liq.held()).toEqual([]);
  });

  it('keeps redeemed MEZO while Tigris pays too little, and never counts it as MEZO repay inventory', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const shares = 450_000n * 10n ** 24n;
    const mezo = 450_000n * E18;
    const { sender, sent } = fakeSender((r) => (r.functionName === 'redeem' ? { logs: [withdrawLog(POOL_MEZO, mezo, shares)] } : {}));
    // The keeper holds 1,000 MEZO of its own on top of what the lot redeemed.
    const client = mezoClient(0.004, { [POOL_MEZO]: shares, [MEZO_TOKEN]: mezo + 1_000n * E18, [MUSD_TOKEN]: 0n });
    const liq = new Liquidator(keeperCtx(client, sender) as never, {} as never);
    liq.store.update((s) => {
      s.held['0:0'] = { collateralId: 0, marketId: 0, amount: shares, cost: 1_950n * E18, minProceeds: 0n, since: 0, lastTx: '0x01' };
    });
    await liq.convertHeld(crossProtocol, MEZO_PRICES);
    expect(sent.map((w) => w.functionName)).toEqual(['redeem']);
    expect(liq.held()).toMatchObject([{ amount: 0n, redeemed: { amount: mezo, cost: 1_950n * E18 } }]);
    const inventory = await (liq as unknown as { inventory: (p: ProtocolState) => Promise<Record<number, bigint>> }).inventory(crossProtocol);
    expect(inventory[1]).toBe(1_000n * E18); // only the keeper's own MEZO repays MEZO debt
  });
});

describe('pair choice at realisable value (final review A9)', () => {
  /** MUSD debt against BTC (8% bonus: best at oracle prices) and pMUSD (3%), which redeems at par. */
  const mixed: ProtocolState = {
    ...btcProtocol,
    collaterals: [
      { ...btcProtocol.collaterals[0], bonusBps: 800 },
      { ...protocol.collaterals[0], id: 1, token: POOL_MUSD, priceKey: PRICE_KEYS.MUSD, symbol: 'pMUSD', ltBps: 8_000, bonusBps: 300 },
    ],
    liquidationFeeBps: 0,
  };
  const account: PositionState = {
    ...btcPosition(E18 / 2n, 52_000n * E18),
    collateral: [
      { id: 0, balance: E18 / 2n, valueUsd: 0n },
      { id: 1, balance: 20_000n * 10n ** 24n, valueUsd: 0n },
    ],
  };
  // Tigris pays 70,000 MUSD per BTC (12.5% below the oracle): the BTC plan would sell at a loss.
  const client = (simulated: unknown[]) => ({
    ...btcClient(70_000),
    simulateContract: async ({ args }: { args: readonly unknown[] }) => (
      simulated.push(args),
      { result: 1n, request: { functionName: 'triggerLiquidation', address: GATEWAY, args } }
    ),
  });

  it('falls back to the next pair when the best one at oracle prices does not pay (LIQUIDATE_UNSELLABLE=skip)', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const e = evaluateAccount(mixed, account, BTC_PRICES);
    expect(e.candidates.map((c) => c.collateralId)).toEqual([0, 1]); // BTC first at oracle prices
    const simulated: unknown[] = [];
    const liq = new Liquidator(keeperCtx(client(simulated), fakeSender().sender, { unsellablePolicy: 'skip' }) as never, {} as never);
    const { plan, assessment } = await liq.choose(mixed, e, BTC_PRICES, []);
    expect(plan.collateralId).toBe(1);
    expect(assessment).toMatchObject({ action: 'liquidate', sale: null, collateralId: 1 });
    await liq.execute(mixed, e, [], true, { plan, assessment });
    expect((simulated[0] as unknown[])[3]).toBe(1n); // the pMUSD pair is the one sent
  });

  it('prefers collateral it can realise now over BTC it would have to hold (LIQUIDATE_UNSELLABLE=hold)', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const e = evaluateAccount(mixed, account, BTC_PRICES);
    const liq = new Liquidator(keeperCtx(client([]), fakeSender().sender) as never, {} as never);
    expect(await liq.assess(mixed, e, BTC_PRICES, [])).toMatchObject({ action: 'liquidate', sale: 'hold', collateralId: 0 });
    expect((await liq.choose(mixed, e, BTC_PRICES, [])).plan.collateralId).toBe(1);
  });
});

describe('one pair that cannot be priced does not block the others (final review V1)', () => {
  const mixed: ProtocolState = {
    ...btcProtocol,
    collaterals: [
      { ...btcProtocol.collaterals[0], bonusBps: 800 },
      { ...protocol.collaterals[0], id: 1, token: POOL_MUSD, priceKey: PRICE_KEYS.MUSD, symbol: 'pMUSD', ltBps: 8_000, bonusBps: 300 },
    ],
    liquidationFeeBps: 0,
  };
  const account: PositionState = {
    ...btcPosition(E18 / 2n, 52_000n * E18),
    collateral: [
      { id: 0, balance: E18 / 2n, valueUsd: 0n },
      { id: 1, balance: 20_000n * 10n ** 24n, valueUsd: 0n },
    ],
  };
  // Pricing a pair can fail on an RPC read (a spoke gas price, a quote): the first candidate's assessment throws.
  const rpcDown = () => Promise.reject(new Error('HTTP 429 from the RPC'));

  it('picks another pair when one cannot be priced', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const e = evaluateAccount(mixed, account, BTC_PRICES);
    expect(e.candidates.map((c) => c.collateralId)).toEqual([0, 1]);
    const liq = new Liquidator(keeperCtx(btcClient(80_000), fakeSender().sender) as never, {} as never);
    vi.spyOn(liq as unknown as { assessPlan: () => Promise<unknown> }, 'assessPlan').mockImplementationOnce(rpcDown);
    const { plan, assessment } = await liq.choose(mixed, e, BTC_PRICES, []);
    expect(plan.collateralId).toBe(1);
    expect(assessment.collateralId).toBe(1);
  });

  it('still fails when no pair can be priced', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const e = evaluateAccount(mixed, account, BTC_PRICES);
    const liq = new Liquidator(keeperCtx(btcClient(80_000), fakeSender().sender) as never, {} as never);
    vi.spyOn(liq as unknown as { assessPlan: () => Promise<unknown> }, 'assessPlan').mockImplementation(rpcDown);
    await expect(liq.choose(mixed, e, BTC_PRICES, [])).rejects.toThrow(/429/);
  });
});

describe('spoke collateral pays for its own release (final review A10)', () => {
  // 0.1 WETH ($280) against 235 MUSD: repay 117.5, seize $125.7, oracle profit $8.2, $7.0 after the 1% haircut.
  const small = () => evaluateAccount(protocol, position(E18 / 10n, 235n * E18), { ETH: 2_800, MUSD: 1 });

  it('counts the spoke gas the keeper pays to relay the release to itself', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const client = { getGasPrice: async () => 0n, readContract: async () => 0n };
    // Ethereum Sepolia at 10 gwei: a 250k-gas receiveMessage costs 0.0025 ETH, $7.
    const liq = new Liquidator(keeperCtx(client, fakeSender().sender, {}, [wethSpoke(10n ** 10n)]) as never, {} as never);
    const a = await liq.assess(protocol, small(), { ETH: 2_800, MUSD: 1 }, []);
    expect(a.costsUsd).toBeCloseTo(0.0025 * 2_800, 6);
    expect(a.action).toBe('skip'); // $7.0 − $7.0 is below MIN_PROFIT_USD
  });

  it('skips spoke collateral released on a chain this agent has no spoke for', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const liq = new Liquidator(keeperCtx({ getGasPrice: async () => 0n, readContract: async () => 0n }, fakeSender().sender, {}, []) as never, {} as never);
    const a = await liq.assess(protocol, evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1 }), { ETH: 2_800, MUSD: 1 }, []);
    expect(a).toMatchObject({ action: 'skip', reason: expect.stringMatching(/no spoke for/) });
  });
});
