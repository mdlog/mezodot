import { beforeEach, describe, expect, it, vi } from 'vitest';
import { erc20Abi, maxUint256, type Address, type PublicClient } from 'viem';
import {
  PRICE_KEYS,
  PRICE_SYMBOLS,
  fetchOracleUpdate,
  leverageManagerAbi,
  readOracle,
  swapLeverageManagerAbi,
  vaultManagerAbi,
  type CollateralState,
  type MarketState,
  type OracleState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '@mezodot/sdk';
import { HUB } from './env';
import { btcCloseSteps, btcLeverageSteps, loopSteps, unwindSteps } from './actions';
import type { TxRequest, TxStep } from './runner';

/** The leverage builders in actions.ts: operator steps, approvals, contract arguments and when prices go along. */

vi.mock('@mezodot/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mezodot/sdk')>()),
  readOracle: vi.fn(),
  fetchOracleUpdate: vi.fn(),
}));

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';
const dep = HUB.deployment!;
const LM = dep.contracts.leverageManager;
const SLM = dep.contracts.swapLeverageManager!;
const E18 = 10n ** 18n;

const market = (id: number, symbol: 'MUSD' | 'MEZO', pool: Address, asset: Address): MarketState =>
  ({ id, symbol, receiptSymbol: `p${symbol}`, pool, asset, decimals: 18, shareDecimals: 24, priceKey: PRICE_KEYS[symbol], exchangeRate: E18 }) as MarketState;
const musd = market(0, 'MUSD', dep.contracts.pMUSD, dep.tokens.MUSD);
const mezo = market(1, 'MEZO', dep.contracts.pMEZO, dep.tokens.MEZO);
const pMUSD = { id: 0, isShare: true, isRemote: false, token: dep.contracts.pMUSD, priceKey: PRICE_KEYS.MUSD, symbol: 'pMUSD' } as CollateralState;
const btc = { id: 2, isShare: false, isRemote: false, token: dep.tokens.BTC!, priceKey: PRICE_KEYS.BTC, decimals: 18, symbol: 'BTC' } as CollateralState;
const protocol = { markets: [musd, mezo], collaterals: [pMUSD, btc] } as unknown as ProtocolState;

/** A position owing `debts` (by market id) and holding `held` collateral (by id). */
const positionWith = (debts: Record<number, bigint>, held: Record<number, bigint> = {}): PositionState =>
  ({
    account: ACCOUNT,
    debts: protocol.markets.map((m) => ({ marketId: m.id, amount: debts[m.id] ?? 0n })),
    collateral: protocol.collaterals.map((c) => ({ id: c.id, balance: held[c.id] ?? 0n, valueUsd: 0n })),
  }) as PositionState;

/** Oracle where `stale` symbols are unavailable and the rest valid for an hour. */
const oracleWith = (stale: PriceSymbol[]) => {
  const now = Math.floor(Date.now() / 1000);
  return Object.fromEntries(
    PRICE_SYMBOLS.map((s) => [s, { ok: !stale.includes(s), validUntil: stale.includes(s) ? 0 : now + 3_600 }]),
  ) as unknown as OracleState;
};

/** A PublicClient answering reads by function name. */
const clientWith = (reads: Record<string, (args: readonly unknown[]) => unknown>) => {
  const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    const read = reads[functionName];
    if (!read) throw new Error(`unexpected read ${functionName}`);
    return read(args ?? []);
  });
  return { client: { readContract } as unknown as PublicClient, readContract };
};

const build = async (s: TxStep) => (await s.request()) as TxRequest | null;
const ctx = (hub: PublicClient, position: PositionState | null) => ({ account: ACCOUNT, hub, protocol, position });

beforeEach(() => {
  vi.mocked(readOracle).mockReset();
  vi.mocked(fetchOracleUpdate).mockReset();
});

describe('MUSD loop', () => {
  it('authorises LeverageManager once, approves the principal and loops with a 0.5% share guard', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith([]));
    const { client } = clientWith({ allowance: () => 0n, previewDeposit: ([gross]) => (gross as bigint) * 10n ** 6n });
    const [authorise, approve, loop] = loopSteps(ctx(client, positionWith({})), musd, 1_000n * E18, 3, false);
    expect(await build(authorise)).toMatchObject({ address: dep.contracts.vaultManager, abi: vaultManagerAbi, functionName: 'setOperator', args: [LM, true] });
    expect(await build(approve)).toMatchObject({ address: musd.asset, abi: erc20Abi, args: [LM, 1_000n * E18] });
    // 3,000 MUSD gross mints 3,000e24 shares; the guard accepts 99.5% of them.
    expect(await build(loop)).toMatchObject({
      address: LM,
      abi: leverageManagerAbi,
      functionName: 'loop',
      args: [1_000n * E18, 3n * E18, 2_985n * 10n ** 24n, []],
      value: 0n,
    });
    expect(await build(loopSteps(ctx(client, positionWith({})), musd, 1n, 3, true)[0])).toBeNull();
  });
});

describe('MUSD unwind (netted against pMUSD)', () => {
  const position = positionWith({ 0: 2_001n * E18 }, { 0: 3_000n * 10n ** 24n });

  it('adds the operator step for a position built by hand', async () => {
    const { client } = clientWith({});
    const [authorise, unwind] = unwindSteps(ctx(client, position), { shares: maxUint256, minOut: 990n, needsPrices: false }, false);
    expect(await build(authorise)).toMatchObject({ address: dep.contracts.vaultManager, functionName: 'setOperator', args: [LM, true] });
    expect(await build(unwindSteps(ctx(client, position), { shares: maxUint256, minOut: 0n, needsPrices: false }, true)[0])).toBeNull();
    // Repays all it can with pMUSD, withdraws the rest; a full unwind carries no price update and reads no oracle.
    expect(await build(unwind)).toMatchObject({ address: LM, functionName: 'unwind', args: [maxUint256, maxUint256, 990n, []], value: 0n });
    expect(readOracle).not.toHaveBeenCalled();
  });

  it('attaches prices only when debt remains while pMUSD is withdrawn', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith(['MEZO']));
    vi.mocked(fetchOracleUpdate).mockResolvedValue({ updates: ['0x01aa'], prices: {}, missing: [] });
    const { client } = clientWith({ updateFee: () => 5n });
    const withMezoDebt = positionWith({ 0: 2_001n * E18, 1: 50n * E18 }, { 0: 3_000n * 10n ** 24n });
    const [, unwind] = unwindSteps(ctx(client, withMezoDebt), { shares: 700n, minOut: 600n, needsPrices: true }, true);
    expect(await build(unwind)).toMatchObject({ functionName: 'unwind', args: [maxUint256, 700n, 600n, ['0x01aa']], value: 5n });
    expect(vi.mocked(fetchOracleUpdate).mock.calls[0][1]).toEqual(['MEZO']);
  });
});

describe('BTC leverage (SwapLeverageManager)', () => {
  it('opens with the borrow as the debt, prices BTC even before it is held, and expires in 20 minutes', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith(['BTC']));
    vi.mocked(fetchOracleUpdate).mockResolvedValue({ updates: ['0x02bb'], prices: {}, missing: [] });
    const { client } = clientWith({ allowance: () => 0n, updateFee: () => 3n });
    const [authorise, approve, open] = btcLeverageSteps(ctx(client, positionWith({})), btc, 5n * 10n ** 15n, 400n * E18, 49n * 10n ** 14n, false);
    expect(await build(authorise)).toMatchObject({ functionName: 'setOperator', args: [SLM, true] });
    expect(await build(approve)).toMatchObject({ address: btc.token, args: [SLM, 5n * 10n ** 15n] });
    const req = await build(open);
    expect(req).toMatchObject({ address: SLM, abi: swapLeverageManagerAbi, functionName: 'open', value: 3n });
    const [principal, borrow, minBought, deadline, updates] = req!.args as [bigint, bigint, bigint, bigint, string[]];
    expect([principal, borrow, minBought, updates]).toEqual([5n * 10n ** 15n, 400n * E18, 49n * 10n ** 14n, ['0x02bb']]);
    expect(Number(deadline) - Date.now() / 1000).toBeGreaterThan(19 * 60);
    // A debt-free account: the borrow prices MUSD and the BTC it will post.
    expect(vi.mocked(fetchOracleUpdate).mock.calls[0][1]).toEqual(['BTC']);
  });

  it('closes a position built by hand after authorising SwapLeverageManager, with no price when nothing else is owed', async () => {
    const { client } = clientWith({});
    const position = positionWith({ 0: 400n * E18 }, { 2: 10n ** 16n });
    const [authorise, close] = btcCloseSteps(ctx(client, position), 5n * 10n ** 15n, 401n * E18, false);
    expect(await build(authorise)).toMatchObject({ address: dep.contracts.vaultManager, functionName: 'setOperator', args: [SLM, true] });
    const req = await build(close);
    expect(req).toMatchObject({ address: SLM, functionName: 'close', value: 0n });
    expect((req!.args as unknown[]).slice(0, 4)).toEqual([maxUint256, maxUint256, 5n * 10n ** 15n, 401n * E18]);
    expect((req!.args as unknown[])[5]).toEqual([]);
    expect(readOracle).not.toHaveBeenCalled();
    expect(await build(btcCloseSteps(ctx(client, position), 1n, 1n, true)[0])).toBeNull();
  });

  it('prices the withdrawal when another market still has debt', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith(['BTC', 'MEZO']));
    vi.mocked(fetchOracleUpdate).mockResolvedValue({ updates: ['0x02cc'], prices: {}, missing: ['MEZO'] });
    const { client } = clientWith({ updateFee: () => 2n });
    const position = positionWith({ 0: 400n * E18, 1: 10n * E18 }, { 2: 10n ** 16n });
    const [, close] = btcCloseSteps(ctx(client, position), 5n * 10n ** 15n, 401n * E18, true);
    const req = await build(close);
    expect((req!.args as unknown[])[5]).toEqual(['0x02cc']);
    expect(req!.value).toBe(2n);
    expect(vi.mocked(fetchOracleUpdate).mock.calls[0][1]).toEqual(['MEZO', 'BTC']);
  });
});
