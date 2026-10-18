import { beforeEach, describe, expect, it, vi } from 'vitest';
import { erc20Abi, maxUint256, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import {
  GAS_FLOOR,
  PRICE_KEYS,
  PRICE_SYMBOLS,
  fetchOracleUpdate,
  readOracle,
  toBytes32,
  type CollateralState,
  type MarketState,
  type OracleState,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '@mezodot/sdk';
import { HUB, SPOKES } from './env';
import {
  REPAY_WITH_COLLATERAL,
  borrowSteps,
  claimSteps,
  postCollateralSteps,
  priceUpdate,
  relayHubSteps,
  relaySpokeSteps,
  repaySteps,
  repayWithCollateralSteps,
  spokeDepositSteps,
  supplySteps,
  withdrawCollateralSteps,
  withdrawRemoteSteps,
  withdrawSteps,
} from './actions';
import { priceUpdatesIn, type TxRequest, type TxStep } from './runner';

vi.mock('@mezodot/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mezodot/sdk')>()),
  readOracle: vi.fn(),
  fetchOracleUpdate: vi.fn(),
}));

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';
const dep = HUB.deployment!;
const spoke = SPOKES.find((s) => s.deployment)!;
const gateway = spoke.deployment!.contracts.spokeGateway;
const WETH = spoke.deployment!.tokens.WETH;

const market: MarketState = {
  id: 0,
  symbol: 'MUSD',
  receiptSymbol: 'pMUSD',
  pool: dep.contracts.pMUSD,
  asset: dep.tokens.MUSD,
  decimals: 18,
  shareDecimals: 24,
  priceKey: PRICE_KEYS.MUSD,
  totalAssets: 0n,
  totalBorrows: 0n,
  totalReserves: 0n,
  cash: 0n,
  totalSupply: 0n,
  exchangeRate: 10n ** 18n,
  borrowRatePerSecond: 0n,
  supplyRatePerSecond: 0n,
  supplyCap: maxUint256,
  borrowCap: maxUint256,
  reserveFactor: 0n,
} as MarketState;
const collateral = (patch: Partial<CollateralState>): CollateralState =>
  ({
    id: 0,
    enabled: true,
    isRemote: false,
    isShare: true,
    token: dep.contracts.pMUSD,
    chainId: 0,
    remoteToken: '0x',
    decimals: 18,
    priceKey: PRICE_KEYS.MUSD,
    ltvBps: 8_000,
    ltBps: 8_500,
    bonusBps: 500,
    cap: maxUint256,
    total: 0n,
    symbol: 'pMUSD',
    ...patch,
  }) as CollateralState;
const pMUSD = collateral({});
const remoteWeth = collateral({
  id: 1,
  isRemote: true,
  isShare: false,
  token: zeroAddress,
  chainId: spoke.wormholeChainId,
  priceKey: PRICE_KEYS.ETH,
  symbol: 'WETH',
});
const protocol = { markets: [market], collaterals: [pMUSD, remoteWeth] } as unknown as ProtocolState;
/** Owes MUSD, holds spoke WETH: a risk check reads MUSD and ETH. */
const position = {
  account: ACCOUNT,
  debts: [{ marketId: 0, amount: 100n }],
  collateral: [
    { id: 0, balance: 0n, valueUsd: 0n },
    { id: 1, balance: 5n, valueUsd: 0n },
  ],
} as unknown as PositionState;

/** Oracle where `stale` symbols are unavailable and the rest valid for an hour. */
const oracleWith = (stale: PriceSymbol[]) => {
  const now = Math.floor(Date.now() / 1000);
  return Object.fromEntries(
    PRICE_SYMBOLS.map((s) => [s, { ok: !stale.includes(s), validUntil: stale.includes(s) ? 0 : now + 3_600 }]),
  ) as unknown as OracleState;
};

type Reads = Record<string, (args: readonly unknown[]) => unknown>;
/** A PublicClient whose readContract answers by function name. */
const clientWith = (reads: Reads) => {
  const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
    const read = reads[functionName];
    if (!read) throw new Error(`unexpected read ${functionName}`);
    return read(args ?? []);
  });
  return { client: { readContract } as unknown as PublicClient, readContract };
};

const build = async (s: TxStep) => (await s.request()) as TxRequest | null;
const ctx = (hub: PublicClient, pos: PositionState | null = position) => ({ account: ACCOUNT, hub, protocol, position: pos });

beforeEach(() => {
  vi.mocked(readOracle).mockReset();
  vi.mocked(fetchOracleUpdate).mockReset();
});

describe('approvals', () => {
  it('are skipped when the allowance already covers the amount, and sized exactly otherwise', async () => {
    const { client } = clientWith({ allowance: () => 1_000n });
    const [approve, supply] = supplySteps(ctx(client), market, 1_000n);
    expect(await build(approve)).toBeNull();
    const short = clientWith({ allowance: () => 999n }).client;
    const [approveShort] = supplySteps(ctx(short), market, 1_000n);
    expect(await build(approveShort)).toMatchObject({ address: market.asset, abi: erc20Abi, functionName: 'approve', args: [market.pool, 1_000n] });
    expect(approveShort.gasFloor).toBe(GAS_FLOOR.erc20Approve);
    expect(await build(supply)).toMatchObject({ address: market.pool, functionName: 'deposit', args: [1_000n, ACCOUNT] });
    expect(supply.gasFloor).toBe(GAS_FLOOR.poolRedeem);
  });
});

describe('market and collateral builders', () => {
  const { client } = clientWith({ allowance: () => 0n });

  it('withdraw redeems every share for MAX and withdraws assets otherwise', async () => {
    expect(await build(withdrawSteps(ctx(client), market, 5n, { shares: 7n })[0])).toMatchObject({ functionName: 'redeem', args: [7n, ACCOUNT, ACCOUNT] });
    expect(await build(withdrawSteps(ctx(client), market, 5n, null)[0])).toMatchObject({ functionName: 'withdraw', args: [5n, ACCOUNT, ACCOUNT] });
  });

  it('repay-all approves the debt plus 0.1% of interest headroom and repays uint max', async () => {
    const [approve, repay] = repaySteps(ctx(client), market, 1_000_000n, true);
    expect(await build(approve)).toMatchObject({ args: [dep.contracts.vaultManager, 1_001_001n] });
    expect(await build(repay)).toMatchObject({ address: dep.contracts.vaultManager, functionName: 'repay', args: [0n, maxUint256, ACCOUNT] });
    const [, partial] = repaySteps(ctx(client), market, 500n, false);
    expect(await build(partial)).toMatchObject({ args: [0n, 500n, ACCOUNT] });
  });

  it('posting collateral approves VaultManager for the shares', async () => {
    const [approve, post] = postCollateralSteps(ctx(client), pMUSD, 42n);
    expect(await build(approve)).toMatchObject({ address: pMUSD.token, args: [dep.contracts.vaultManager, 42n] });
    expect(await build(post)).toMatchObject({ functionName: 'depositCollateral', args: [0n, 42n] });
  });

  it('repaying with collateral burns posted shares in one call: no approval, no prices, no value', async () => {
    const { client: hub, readContract } = clientWith({});
    const steps = repayWithCollateralSteps(ctx(hub), market, pMUSD, maxUint256);
    expect(REPAY_WITH_COLLATERAL).toBe(true);
    expect(steps).toHaveLength(1);
    const req = await build(steps[0]);
    expect(req).toMatchObject({ address: dep.contracts.vaultManager, functionName: 'repayWithCollateral', args: [ACCOUNT, 0n, 0n, maxUint256] });
    expect(req?.value).toBeUndefined();
    expect(readContract).not.toHaveBeenCalled();
    expect(readOracle).not.toHaveBeenCalled();
  });
});

describe('price updates', () => {
  it('fetches only the symbols that would expire, and pays the router fee for them', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith(['ETH']));
    vi.mocked(fetchOracleUpdate).mockResolvedValue({ updates: ['0x02aa'], prices: {}, missing: [] });
    const { client } = clientWith({ updateFee: () => 7n });
    const req = await build(withdrawCollateralSteps(ctx(client), pMUSD, 3n)[0]);
    expect(vi.mocked(fetchOracleUpdate).mock.calls[0][1]).toEqual(['ETH']);
    expect(req).toMatchObject({ functionName: 'withdrawCollateral', args: [0n, 3n, ACCOUNT, ['0x02aa']], value: 7n });
    expect(priceUpdatesIn(req)).toEqual({ updates: ['0x02aa'], relayError: null });
  });

  it('read nothing for a debt-free account that borrows nothing', async () => {
    const { client, readContract } = clientWith({});
    expect(await priceUpdate(client, [])).toEqual({ updates: [], fee: 0n });
    expect(readOracle).not.toHaveBeenCalled();
    expect(readContract).not.toHaveBeenCalled();
  });

  it('go out empty when the agent relay is down, and say why, so the estimate decides', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith(['ETH']));
    vi.mocked(fetchOracleUpdate).mockRejectedValue(new Error('fetch failed'));
    const { client } = clientWith({});
    const req = await build(withdrawCollateralSteps(ctx(client), pMUSD, 3n)[0]);
    expect(req).toMatchObject({ args: [0n, 3n, ACCOUNT, []], value: 0n });
    expect(priceUpdatesIn(req)?.relayError).toBe('the Mezodot agent did not return ETH prices: fetch failed');
  });

  it('a borrow also prices the borrowed market', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith(['MUSD', 'ETH']));
    vi.mocked(fetchOracleUpdate).mockResolvedValue({ updates: [], prices: {}, missing: ['MUSD'] });
    const { client } = clientWith({});
    const debtFree = { ...position, debts: [{ marketId: 0, amount: 0n }] } as PositionState;
    const req = await build(borrowSteps(ctx(client, debtFree), market, 10n)[0]);
    expect(vi.mocked(fetchOracleUpdate).mock.calls[0][1]).toEqual(['MUSD', 'ETH']);
    expect(req).toMatchObject({ functionName: 'borrow', args: [0n, 10n, []], value: 0n });
  });
});

describe('cross-chain builders', () => {
  /** Spoke and hub reads of a gateway that is live and registered on the hub. */
  const live = (patch: Reads = {}): Reads => ({
    paused: () => false,
    tokens: () => [true, 10n ** 24n],
    locked: () => 0n,
    hubEmitter: () => toBytes32(dep.contracts.wormholeAdapter),
    spokeEmitter: () => toBytes32(gateway),
    remoteCollateralId: () => 2n,
    balanceOf: () => 4n,
    allowance: () => 0n,
    messageFee: () => 3n,
    ...patch,
  });

  it('wrap only the WETH shortfall, approve the gateway and pay the Wormhole fee', async () => {
    const { client } = clientWith(live());
    const [wrap, approve, lock] = spokeDepositSteps(ACCOUNT, spoke, { spoke: client, hub: client }, WETH, 'WETH', 10n, { wrapNative: true });
    expect(await build(wrap)).toMatchObject({ address: WETH, functionName: 'deposit', value: 6n });
    expect(await build(approve)).toMatchObject({ address: WETH, args: [gateway, 10n] });
    expect(await build(lock)).toMatchObject({ address: gateway, functionName: 'deposit', args: [WETH, 10n], value: 3n });
    expect([wrap, approve, lock].every((s) => s.chainId === spoke.chain.id)).toBe(true);
  });

  it('refuse before the first transaction when the gateway is paused, full or not registered on the hub', async () => {
    const cases: [Reads, RegExp][] = [
      [{ paused: () => true }, /gateway is paused/],
      [{ tokens: () => [false, 0n] }, /not accepted/],
      [{ locked: () => 10n ** 24n }, /reached its WETH cap/],
      [{ locked: () => 10n ** 24n - 5n }, /more WETH than the .* gateway still accepts/],
      [{ spokeEmitter: () => toBytes32(zeroAddress) }, /not connected to the Mezo hub/],
      [{ remoteCollateralId: () => 0n }, /not connected to the Mezo hub/],
      [{ hubEmitter: () => toBytes32(ACCOUNT) }, /not connected to the Mezo hub/],
    ];
    for (const [patch, message] of cases) {
      const { client, readContract } = clientWith(live(patch));
      const [first] = spokeDepositSteps(ACCOUNT, spoke, { spoke: client, hub: client }, WETH, 'WETH', 10n, { wrapNative: true });
      await expect(build(first)).rejects.toThrow(message);
      expect(readContract.mock.calls.some(([c]) => c.functionName === 'balanceOf')).toBe(false); // nothing built past the check
    }
  });

  it('release pays the oracle and Wormhole fees and names the recipient in bytes32', async () => {
    vi.mocked(readOracle).mockResolvedValue(oracleWith([]));
    const { client } = clientWith({ messageFee: () => 11n });
    const req = await build(withdrawRemoteSteps(ctx(client), remoteWeth, 2n)[0]);
    expect(req).toMatchObject({ functionName: 'withdrawRemote', args: [1n, 2n, toBytes32(ACCOUNT), []], value: 11n });
  });

  it('claims a deferred release to the wallet, and skips it once nothing is left', async () => {
    const USDC = spoke.deployment!.tokens.USDC;
    const { client, readContract } = clientWith({ claimable: () => 5n });
    const [claim] = claimSteps(ACCOUNT, spoke, client, USDC, 'USDC');
    expect(claim.chainId).toBe(spoke.chain.id);
    expect(await build(claim)).toMatchObject({ address: gateway, functionName: 'claim', args: [USDC, ACCOUNT] });
    expect(readContract.mock.calls[0][0]).toMatchObject({ address: gateway, functionName: 'claimable', args: [ACCOUNT, USDC] });
    const elsewhere: Address = '0x00000000000000000000000000000000000000c3';
    expect(await build(claimSteps(ACCOUNT, spoke, client, USDC, 'USDC', elsewhere)[0])).toMatchObject({ args: [USDC, elsewhere] });
    const [empty] = claimSteps(ACCOUNT, spoke, clientWith({ claimable: () => 0n }).client, USDC, 'USDC');
    expect(await build(empty)).toBeNull();
    expect(() => claimSteps(ACCOUNT, { ...spoke, deployment: null }, client, USDC, 'USDC')).toThrow(/not deployed/);
  });

  it('self-relays carry the VAA-relay gas floor', async () => {
    const vaa: Hex = '0x01';
    const [hub] = relayHubSteps(vaa);
    expect(await build(hub)).toMatchObject({ address: dep.contracts.keeperGateway, functionName: 'relayMessage', args: [vaa] });
    const [toSpoke] = relaySpokeSteps(spoke, vaa);
    expect(await build(toSpoke)).toMatchObject({ address: gateway, functionName: 'receiveMessage', args: [vaa] });
    expect([hub.gasFloor, toSpoke.gasFloor]).toEqual([GAS_FLOOR.vaaRelay, GAS_FLOOR.vaaRelay]);
    expect(() => relaySpokeSteps({ ...spoke, deployment: null }, vaa)).toThrow(/not deployed/);
  });
});
