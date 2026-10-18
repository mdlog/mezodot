import { describe, expect, it } from 'vitest';
import { PRICE_KEYS, type PositionState, type ProtocolState } from '@mezodot/sdk';
import { evaluateAccount } from '../src/liquidator';

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
});

const protocol: ProtocolState = {
  markets: [market(0, POOL_MUSD, 'MUSD'), market(1, POOL_MEZO, 'MEZO')],
  collaterals: [
    {
      id: 0,
      enabled: true,
      isRemote: false,
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
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
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
    const ctx = {
      config: { stateDir: mkdtempSync(join(tmpdir(), 'mezodot-liq-')), env: 'devnet' },
      hub: {
        network: 'devnet-hub',
        client,
        wallet: null,
        deployment: { startBlock: 0, contracts: { vaultManager: '0x0000000000000000000000000000000000000001' } },
      },
      spokes: [],
      log: () => {},
    };
    const liq = new Liquidator(ctx as never);
    const accounts = await liq.syncAccounts();
    expect(accounts).toHaveLength(3);
    expect(calls.length).toBeGreaterThan(2);
    expect(liq.store.get().cursor).toBe(25_001n);
  });

  it('values with the prices a liquidation will post, not an outdated stored pull price', async () => {
    const { Liquidator } = await import('../src/liquidator');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
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
    };
    const asked: string[][] = [];
    const relay = {
      oracle: async () => oracle,
      update: async (symbols: string[]) => (
        asked.push(symbols),
        { updates: ['0x02aa'], prices: { ETH: { price: 2_800, publishTime: 1, source: 'supra' } }, missing: [] }
      ),
    };
    const ctx = { config: { stateDir: mkdtempSync(join(tmpdir(), 'mezodot-liq-')), env: 'testnet' }, hub: {}, spokes: [], log: () => {} };
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
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    let simulatedValue: bigint | undefined;
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'updateFee' ? 4n : functionName === 'messageFee' ? 1_000n : functionName === 'allowance' ? 10n ** 30n : 0n,
      simulateContract: async ({ value }: { value: bigint }) => {
        simulatedValue = value;
        return { result: 1n, request: {} };
      },
    };
    const ctx = {
      config: { stateDir: mkdtempSync(join(tmpdir(), 'mezodot-liq-')), env: 'devnet' },
      hub: {
        network: 'devnet-hub',
        client,
        wallet: { account: { address: '0x00000000000000000000000000000000000000ee' } },
        deployment: {
          startBlock: 0,
          contracts: {
            keeperGateway: '0x0000000000000000000000000000000000000002',
            oracleRouter: '0x0000000000000000000000000000000000000003',
            wormholeAdapter: '0x0000000000000000000000000000000000000004',
          },
        },
      },
      spokes: [],
      log: () => {},
    };
    const liq = new Liquidator(ctx as never);
    const e = evaluateAccount(protocol, position(E18, 2_350n * E18), { ETH: 2_800, MUSD: 1 });
    await liq.execute(protocol, e, ['0x01'], true);
    expect(simulatedValue).toBe(4n + 1_000n);
    const local = evaluateAccount(protocol, position(0n, 3_900n * E18, 1_000_000n * 10n ** 24n), { MEZO: 0.004764, MUSD: 1, ETH: 3_000 });
    await liq.execute(protocol, local, ['0x01'], true);
    expect(simulatedValue).toBe(4n);
  });
});
