import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import {
  PRICE_KEYS,
  PRICE_SYMBOLS,
  readPosition,
  readProtocol,
  vaultManagerAbi,
  type OracleState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '@mezodot/sdk';
import { Liquidator } from '../src/liquidator';

// Protocol and position reads are stubbed; everything else (valuation, planning, assessment) is the real code.
vi.mock('@mezodot/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mezodot/sdk')>()),
  readProtocol: vi.fn(),
  readPosition: vi.fn(),
}));

const E18 = 10n ** 18n;
const VAULT = '0x0000000000000000000000000000000000000001';
const GATEWAY = '0x0000000000000000000000000000000000000002';
const MUSD = '0x00000000000000000000000000000000000000c1';
const KEEPER = '0x00000000000000000000000000000000000000ee';
const BIG = '0x00000000000000000000000000000000000000b1';
const SMALL = '0x00000000000000000000000000000000000000b2';
const NO_PRICE = '0x00000000000000000000000000000000000000b3';

const protocol: ProtocolState = {
  markets: [
    {
      id: 0,
      symbol: 'MUSD',
      receiptSymbol: 'pMUSD',
      pool: '0x00000000000000000000000000000000000000a1',
      asset: MUSD,
      decimals: 18,
      shareDecimals: 24,
      priceKey: PRICE_KEYS.MUSD,
      totalAssets: 0n,
      totalBorrows: 0n,
      totalReserves: 0n,
      cash: 0n,
      totalSupply: 0n,
      exchangeRate: E18,
      borrowRatePerSecond: 0n,
      supplyRatePerSecond: 0n,
      supplyCap: 0n,
      borrowCap: 0n,
      reserveFactor: 10n ** 17n,
    },
  ],
  collaterals: [
    {
      id: 0,
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
    {
      id: 1,
      enabled: true,
      isRemote: false,
      isShare: false,
      token: '0x7b7C000000000000000000000000000000000000',
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
  keeperCount: 0n,
  blockNumber: 0n,
  liquidationFeeBps: 0,
  treasury: '0x0000000000000000000000000000000000000000',
};

const position = (account: `0x${string}`, weth: bigint, debt: bigint, btc = 0n): PositionState => ({
  account,
  snapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: 0n, healthFactor: 0n },
  collateral: [
    { id: 0, balance: weth, valueUsd: 0n },
    { id: 1, balance: btc, valueUsd: 0n },
  ],
  debts: [{ marketId: 0, amount: debt }],
  isLeverageOperator: false,
  isSwapLeverageOperator: false,
});

/** Router state with a usable Pyth price for each symbol in `prices` (nothing to pull). */
const oracleState = (prices: Partial<Record<PriceSymbol, number>>): OracleState =>
  Object.fromEntries(
    PRICE_SYMBOLS.map((symbol) => {
      const p = prices[symbol];
      const wad = p === undefined ? 0n : BigInt(Math.round(p * 1e6)) * 10n ** 12n;
      return [
        symbol,
        {
          symbol,
          feed: { primary: { source: 1, maxAge: 3_900, id: `0x${'1'.repeat(64)}` }, secondary: null, maxConfBps: 500, maxDivergenceBps: 0 },
          ok: p !== undefined,
          price: wad,
          validUntil: 2_000_000_000,
          lastPrice: wad,
          publishTime: 1,
          legs: [],
        },
      ];
    }),
  ) as unknown as OracleState;

function setup(opts: { positions: PositionState[]; accounts: `0x${string}`[]; inventory: bigint; syncFails?: boolean; keeper?: boolean }) {
  const logs: { message: string; extra?: Record<string, unknown> }[] = [];
  const sent: { functionName: string; args: readonly unknown[] }[] = [];
  const simulated: bigint[] = [];
  vi.mocked(readProtocol).mockResolvedValue(protocol);
  vi.mocked(readPosition).mockImplementation(
    async (_c, _h, _p, account) => opts.positions.find((p) => p.account === account) ?? Promise.reject(new Error('unknown')),
  );
  const client = {
    getBlockNumber: async () => 100n,
    getContractEvents: async () => (opts.syncFails ? Promise.reject(new Error('fetch failed: rpc down')) : []),
    getGasPrice: async () => 0n,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'balanceOf' ? opts.inventory : functionName === 'allowance' ? 10n ** 30n : 0n,
    simulateContract: async ({ args }: { args: readonly unknown[] }) => (
      simulated.push(args[2] as bigint),
      { result: 1n, request: { functionName: 'triggerLiquidation', args } }
    ),
  };
  const keeper = opts.keeper ?? true;
  // VaultManager's Liquidated event for what each triggerLiquidation(account, market, repay, collateral, …) asked.
  const liquidated = ([account, marketId, repaid, collateralId]: readonly unknown[]) => ({
    address: VAULT,
    topics: encodeEventTopics({
      abi: vaultManagerAbi,
      eventName: 'Liquidated',
      args: { account: account as Hex, liquidator: GATEWAY, marketId: marketId as bigint },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [collateralId as bigint, repaid as bigint, 1n]),
  });
  const sender = {
    address: KEEPER,
    send: async (request: { functionName: string; args: readonly unknown[] }) => {
      sent.push(request);
      const logs = request.functionName === 'triggerLiquidation' ? [liquidated(request.args)] : [];
      return { hash: `0x${'ab'.repeat(32)}`, receipt: { status: 'success', logs }, gas: 0n, nonce: 0 };
    },
  };
  const ctx = {
    config: {
      stateDir: mkdtempSync(join(tmpdir(), 'mezodot-tick-')),
      env: 'testnet',
      minProfitUsd: 1,
      unsellablePolicy: 'hold',
      maxSaleDiscountBps: 500,
      minGasBalance: {},
    },
    hub: {
      network: 'mezo-testnet',
      client,
      wallet: keeper ? { account: { address: KEEPER } } : null,
      sender: keeper ? sender : null,
      deployment: { startBlock: 0, contracts: { vaultManager: VAULT, keeperGateway: GATEWAY }, tokens: { MUSD } },
    },
    // The spoke WETH is released on: the keeper relays those releases to itself.
    spokes: [{ network: 'base-sepolia', client: { getGasPrice: async () => 0n }, deployment: { wormholeChainId: 10004, contracts: {} } }],
    log: (_s: string, message: string, extra?: Record<string, unknown>) => logs.push({ message, extra }),
  };
  const symbolsAsked: PriceSymbol[][] = [];
  const relay = {
    oracle: async () => oracleState({ MUSD: 1, ETH: 2_800, BTC: 80_000 }),
    update: async (symbols: PriceSymbol[]) => (symbolsAsked.push(symbols), { updates: [], prices: {}, missing: symbols }),
  };
  const liq = new Liquidator(ctx as never, relay as never);
  liq.store.update((s) => void (s.accounts = opts.accounts));
  return { liq, logs, sent, simulated };
}

beforeEach(() => vi.clearAllMocks());

describe('liquidator tick', () => {
  it('liquidates the largest shortfall first and re-plans the next one against the inventory left', async () => {
    // Both are under water; BIG leaves $460 uncovered, SMALL $46. The keeper holds 1,400 MUSD.
    const t = setup({
      accounts: [SMALL, BIG],
      positions: [position(SMALL, E18 / 10n, 270n * E18), position(BIG, E18, 2_700n * E18)],
      inventory: 1_400n * E18,
    });
    await t.liq.tick();
    // BIG first: half its debt, 1,350 MUSD. SMALL was planned at 135 MUSD against the full balance; 50 are left.
    expect(t.simulated).toEqual([1_350n * E18, 50n * E18]);
    expect(t.liq.lastTick).toMatchObject({ evaluated: 2, liquidatable: 2, liquidated: 2, skipped: {} });
  });

  it('evaluates the accounts it already knows when the index sync fails', async () => {
    const t = setup({ accounts: [BIG], positions: [position(BIG, E18, 2_000n * E18)], inventory: 0n, syncFails: true });
    await t.liq.tick();
    expect(t.liq.syncError).toMatch(/rpc down/);
    expect(t.liq.lastEvaluations.map((e) => e.account)).toEqual([BIG]);
    expect(t.logs.map((l) => l.message)).toContain('borrower index sync failed; evaluating known accounts');
  });

  it('counts and reports liquidatable accounts it leaves alone, once per reason', async () => {
    const t = setup({
      accounts: [NO_PRICE, BIG],
      // NO_PRICE holds collateral without a usable price: VaultManager would revert, so there is no plan.
      positions: [{ ...position(NO_PRICE, E18, 2_700n * E18), collateral: [{ id: 0, balance: E18, valueUsd: 0n }] }, position(BIG, E18, 2_700n * E18)],
      inventory: 0n,
    });
    const relay = (t.liq as unknown as { relay: { oracle: () => Promise<OracleState> } }).relay;
    relay.oracle = async () => oracleState({ MUSD: 1, BTC: 80_000 }); // no ETH price at all
    await t.liq.tick();
    await t.liq.tick();
    expect(t.liq.lastTick!.skipped).toEqual({ unpriced: 2 });
    expect(t.logs.filter((l) => l.message === 'liquidatable account skipped: unpriced')).toHaveLength(2); // once per account, not per tick
  });

  it('a keeper without repay inventory, and a read-only agent, say so', async () => {
    const dry = setup({ accounts: [BIG], positions: [position(BIG, E18, 2_700n * E18)], inventory: 0n });
    await dry.liq.tick();
    expect(dry.liq.lastTick!.skipped).toEqual({ 'no repay inventory': 1 });
    const ro = setup({ accounts: [BIG], positions: [position(BIG, E18, 2_700n * E18)], inventory: 0n, keeper: false });
    await ro.liq.tick();
    expect(ro.liq.lastTick!.skipped).toEqual({ 'read-only': 1 });
    expect(ro.sent).toEqual([]);
  });

  it('prices the collateral it holds even when no borrower holds it, so its sale can be bounded', async () => {
    const t = setup({ accounts: [], positions: [], inventory: 0n });
    const asked: PriceSymbol[][] = [];
    const relay = (t.liq as unknown as { relay: { oracle: () => Promise<OracleState>; update: (s: PriceSymbol[]) => Promise<unknown> } }).relay;
    const supraBtc = oracleState({ MUSD: 1 });
    supraBtc.BTC = { ...supraBtc.BTC, feed: { ...supraBtc.BTC.feed!, secondary: { source: 2, maxAge: 120, id: `0x${'0'.repeat(62)}12` } } };
    relay.oracle = async () => supraBtc;
    relay.update = async (symbols) => (asked.push(symbols), { updates: [], prices: {}, missing: [] });
    t.liq.store.update((s) => {
      s.held['1:0'] = { collateralId: 1, marketId: 0, amount: E18, cost: 1n, minProceeds: 0n, since: 0, lastTx: '0x01' };
    });
    await t.liq.tick();
    expect(asked).toEqual([['BTC']]);
  });
});
