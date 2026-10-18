import { describe, expect, it } from 'vitest';
import { pad, type Address, type Hex, type PublicClient } from 'viem';
import { PRICE_KEYS, toBytes32, type HubDeployment, type PriceSymbol, type SpokeDeployment } from '../../packages/sdk/src/index';
import { accruedReserves, collectionPlan, readRevenue, type RevenueReport } from '../lib/revenue';

const A = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const E18 = 10n ** 18n;
const VM = A(1);
const ORACLE = A(2);
const ADAPTER = A(3);
const PMUSD = A(6);
const PMEZO = A(7);
const MUSD = A(16);
const MEZO = A(17);
const BTC = A(18);
const WETH = A(35);
const USDC = A(36);
const TREASURY = A(0xaa);
const OTHER = A(0xbb);
const FEE = 7n;

const hub: HubDeployment = {
  network: 'devnet-hub',
  role: 'hub',
  chainId: 31337,
  wormholeChainId: 50,
  startBlock: 10,
  contracts: {
    vaultManager: VM,
    oracleRouter: ORACLE,
    wormholeAdapter: ADAPTER,
    leverageManager: A(4),
    keeperGateway: A(5),
    pMUSD: PMUSD,
    pMEZO: PMEZO,
    wormhole: A(12),
    pyth: A(13),
    supraPull: A(14),
  },
  tokens: { MUSD, MEZO, BTC },
  priceFeeds: { MUSD: '0x01', MEZO: '0x02', ETH: '0x03', USDC: '0x04', BTC: '0x05' },
};
const spoke: SpokeDeployment = {
  network: 'devnet-spoke',
  role: 'spoke',
  chainId: 31338,
  wormholeChainId: 10004,
  startBlock: 10,
  contracts: { spokeGateway: A(33), wormhole: A(34) },
  tokens: { WETH, USDC },
};

const PRICES: Record<PriceSymbol, bigint> = { MUSD: E18, MEZO: 3n * 10n ** 15n, ETH: 3_000n * E18, USDC: E18, BTC: 80_000n * E18 };
const NO_REMOTE: Hex = `0x${'0'.repeat(64)}`;
const collateral = (
  over: Partial<{ isRemote: boolean; isShare: boolean; token: Address; chainId: number; remoteToken: Hex; decimals: number; priceKey: Hex }>,
) => ({
  enabled: true,
  isRemote: false,
  isShare: false,
  token: A(0),
  chainId: 0,
  remoteToken: NO_REMOTE,
  decimals: 18,
  priceKey: PRICE_KEYS.MUSD,
  ltvBps: 7000,
  ltBps: 7800,
  bonusBps: 500,
  cap: 2n ** 256n - 1n,
  ...over,
});

type Pool = { totalReserves: bigint; totalBorrows: bigint; accrualTimestamp: bigint; borrowRatePerSecond: bigint; cash: bigint };
type Log = { address: Address; eventName: string; args: Record<string, unknown>; blockNumber: bigint };

/** A devnet-like hub: pMUSD reserves above its idle cash, pMEZO accruing interest, four collaterals. */
function world() {
  return {
    latest: 12_000n,
    now: 1_000_000n,
    owner: TREASURY,
    treasury: TREASURY,
    debtValue: 0n,
    pools: {
      [PMUSD]: { totalReserves: 5n * E18, totalBorrows: 0n, accrualTimestamp: 1_000_000n, borrowRatePerSecond: 0n, cash: 3n * E18 },
      // 1,000 MEZO borrowed at 1e-9 per second for 1,000 s: 1e15 interest, 10% of it to reserves.
      [PMEZO]: { totalReserves: E18, totalBorrows: 1_000n * E18, accrualTimestamp: 999_000n, borrowRatePerSecond: 10n ** 9n, cash: 100n * E18 },
    } as Record<Address, Pool>,
    collaterals: [
      collateral({ isShare: true, token: PMUSD, priceKey: PRICE_KEYS.MUSD }),
      collateral({ token: BTC, priceKey: PRICE_KEYS.BTC }),
      collateral({ isRemote: true, chainId: 10004, remoteToken: toBytes32(WETH), priceKey: PRICE_KEYS.ETH }),
      collateral({ isRemote: true, chainId: 10004, remoteToken: toBytes32(USDC), decimals: 6, priceKey: PRICE_KEYS.USDC }),
    ],
    // pMUSD shares (10^6 per MUSD on an empty pool): 2 MUSD worth; 0.001 BTC; 0.5 WETH; no USDC.
    treasuryBalances: [2n * 10n ** 24n, 10n ** 15n, 5n * 10n ** 17n, 0n],
    logs: [
      { address: PMUSD, eventName: 'FlashLoan', args: { fee: 2n * E18 }, blockNumber: 100n },
      { address: PMUSD, eventName: 'FlashLoan', args: { fee: E18 }, blockNumber: 9_000n },
      { address: PMEZO, eventName: 'ReservesWithdrawn', args: { amount: 4n * 10n ** 17n }, blockNumber: 11_500n },
      { address: PMUSD, eventName: 'BadDebtWrittenOff', args: { amount: E18, fromReserves: 3n * 10n ** 17n }, blockNumber: 11_900n },
      { address: VM, eventName: 'LiquidationFeeTaken', args: { collateralId: 1n, amount: 10n ** 15n }, blockNumber: 6_000n },
      { address: OTHER, eventName: 'LiquidationFeeTaken', args: { collateralId: 1n, amount: 99n }, blockNumber: 6_001n },
    ] as Log[],
    logCalls: [] as { fromBlock: bigint; toBlock: bigint }[],
  };
}
type World = ReturnType<typeof world>;
type Call = { address: Address; functionName: string; args?: readonly unknown[] };

function fakeClient(w: World): PublicClient {
  const read = ({ address, functionName: fn, args = [] }: Call): unknown => {
    if (address === VM) {
      return {
        owner: w.owner,
        treasury: w.treasury,
        liquidationFeeBps: 1000,
        marketCount: 2n,
        collateralCount: BigInt(w.collaterals.length),
        adapter: ADAPTER,
        markets: [
          { pool: PMUSD, priceKey: PRICE_KEYS.MUSD, decimals: 18, enabled: true },
          { pool: PMEZO, priceKey: PRICE_KEYS.MEZO, decimals: 18, enabled: true },
        ][Number(args[0])],
        collaterals: w.collaterals[Number(args[0])],
        collateralBalance: args[0] === w.treasury ? w.treasuryBalances[Number(args[1])] : 0n,
        getRiskSnapshot: { collateralValue: 0n, adjustedCollateral: 0n, borrowLimit: 0n, debtValue: w.debtValue, healthFactor: 0n },
      }[fn];
    }
    if (address === ORACLE && fn === 'getPriceUnsafe') {
      const symbol = (Object.keys(PRICE_KEYS) as PriceSymbol[]).find((s) => PRICE_KEYS[s] === args[0])!;
      return [PRICES[symbol], 1n];
    }
    if (address === ADAPTER && fn === 'messageFee') return FEE;
    const pool = w.pools[address];
    if (!pool) return undefined;
    // Empty-pool exchange rate: 10^6 shares per unit (PToken's virtual offset).
    if (fn === 'convertToAssets') return (args[0] as bigint) / 10n ** 6n;
    if (fn === 'convertToShares') return (args[0] as bigint) * 10n ** 6n;
    return { ...pool, symbol: address === PMUSD ? 'pMUSD' : 'pMEZO', decimals: 24, reserveFactor: E18 / 10n }[fn];
  };
  return {
    getBlock: async () => ({ number: w.latest, timestamp: w.now }),
    readContract: async (c: Call) => {
      const value = read(c);
      if (value === undefined) throw new Error(`fake: no ${c.functionName} on ${c.address}`);
      return value;
    },
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      w.logCalls.push({ fromBlock, toBlock });
      return w.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
  } as unknown as PublicClient;
}

const report = (w: World, events = true) =>
  readRevenue({ network: 'devnet-hub', deployment: hub, client: fakeClient(w), spokes: [{ network: 'devnet-spoke', deployment: spoke }] }, { events });

describe('accruedReserves', () => {
  const pool = { totalBorrows: 1_000n * E18, totalReserves: E18, reserveFactor: E18 / 10n, borrowRatePerSecond: 10n ** 9n, accrualTimestamp: 999_000n };

  it('adds the reserve-factor share of the interest pending since the last accrual', () => {
    // 1,000e18 × (1e9 × 1,000 s) / 1e18 = 1e15 interest; 10% of it.
    expect(accruedReserves(pool, 1_000_000n)).toBe(E18 + 10n ** 14n);
  });

  it('is the stored value with nothing to accrue', () => {
    expect(accruedReserves(pool, 999_000n)).toBe(E18);
    expect(accruedReserves(pool, 998_000n)).toBe(E18); // clock behind the last accrual
    expect(accruedReserves({ ...pool, totalBorrows: 0n }, 1_000_000n)).toBe(E18);
  });
});

describe('readRevenue', () => {
  it('reports reserves, what idle cash lets the owner withdraw, and lifetime totals per pool', async () => {
    const r = await report(world());
    const [musd, mezo] = r.pools;
    expect(musd).toMatchObject({ label: 'pMUSD', asset: 'MUSD', totalReserves: 5n * E18, accruedReserves: 5n * E18, withdrawable: 3n * E18, price: 1 });
    expect(musd.events).toEqual({ flashFees: 3n * E18, reservesWithdrawn: 0n, badDebtAbsorbed: 3n * 10n ** 17n });
    expect(mezo).toMatchObject({ asset: 'MEZO', accruedReserves: E18 + 10n ** 14n, withdrawable: E18 + 10n ** 14n });
    expect(mezo.events?.reservesWithdrawn).toBe(4n * 10n ** 17n);
    expect(r).toMatchObject({
      blockNumber: 12_000n,
      treasury: TREASURY,
      liquidationFeeBps: 1000,
      messageFee: FEE,
      scanned: { fromBlock: 10n, toBlock: 12_000n },
    });
  });

  it("values the treasury's custody balances by kind and counts fees taken only from the VaultManager", async () => {
    const r = await report(world());
    const [shares, btc, weth, usdc] = r.holdings;
    // 3 MUSD of idle cash covers all 2·10^24 shares.
    expect(shares).toMatchObject({ label: 'pMUSD', kind: 'share', assets: 2n * E18, redeemable: 2n * 10n ** 24n, usd: 2 });
    expect(btc).toMatchObject({ label: 'BTC', kind: 'plain', balance: 10n ** 15n, usd: 80, feesTaken: 10n ** 15n });
    expect(weth).toMatchObject({ label: 'devnet-spoke WETH', kind: 'remote', chainId: 10004, remoteToken: WETH, usd: 1500 });
    expect(usdc).toMatchObject({ label: 'devnet-spoke USDC', balance: 0n, assetDecimals: 6, feesTaken: 0n });
  });

  it('caps redeemable shares by the pool cash', async () => {
    const w = world();
    w.pools[PMUSD].cash = E18; // redeems 1 MUSD = 10^24 shares of the 2·10^24 held
    expect((await report(w)).holdings[0].redeemable).toBe(10n ** 24n);
  });

  it('scans events in chunks of the network log range, from the deployment start block', async () => {
    const w = world();
    await report(w);
    expect(w.logCalls).toEqual([
      { fromBlock: 10n, toBlock: 5_009n },
      { fromBlock: 5_010n, toBlock: 10_009n },
      { fromBlock: 10_010n, toBlock: 12_000n },
    ]);
  });

  it('skips the scan on request', async () => {
    const w = world();
    const r = await report(w, false);
    expect(w.logCalls).toEqual([]);
    expect(r.scanned).toBeNull();
    expect(r.pools[0].events).toBeNull();
    expect(r.holdings[1].feesTaken).toBeNull();
  });
});

describe('collectionPlan', () => {
  const commands = (r: RevenueReport, to?: Address) => collectionPlan(r, to).steps.map((s) => `${s.signer}: ${s.command}`);

  it('withdraws reserves up to idle cash and every custody balance, by kind', async () => {
    const w = world();
    w.pools[PMUSD].cash = E18;
    const plan = collectionPlan(await report(w));
    const steps = plan.steps.map((s) => `${s.signer}: ${s.command}`);
    expect(steps).toEqual([
      `owner: cast send ${PMUSD} "withdrawReserves(uint256,address)" ${E18} ${TREASURY} --rpc-url "$RPC" --keystore "$KEYSTORE"`,
      `owner: cast send ${PMEZO} "withdrawReserves(uint256,address)" ${E18 + 10n ** 14n} ${TREASURY} --rpc-url "$RPC" --keystore "$KEYSTORE"`,
      `treasury: cast send ${VM} "withdrawCollateral(uint256,uint256,address,bytes[])" 0 ${2n * 10n ** 24n} ${TREASURY} "[]" --rpc-url "$RPC" --keystore "$KEYSTORE"`,
      `treasury: cast send ${PMUSD} "redeem(uint256,address,address)" ${10n ** 24n} ${TREASURY} ${TREASURY} --rpc-url "$RPC" --keystore "$KEYSTORE"`,
      `treasury: cast send ${VM} "withdrawCollateral(uint256,uint256,address,bytes[])" 1 ${10n ** 15n} ${TREASURY} "[]" --rpc-url "$RPC" --keystore "$KEYSTORE"`,
      `treasury: cast send ${VM} "withdrawRemote(uint256,uint256,bytes32,bytes[])" 2 ${5n * 10n ** 17n} ${pad(TREASURY, { size: 32 })} "[]" --value ${FEE} --rpc-url "$RPC" --keystore "$KEYSTORE"`,
    ]);
    expect(plan.notes).toEqual([
      'pMUSD: reserves exceed idle cash; the rest becomes withdrawable as borrowers repay or suppliers deposit',
      'pMUSD: idle cash redeems only part of the shares now; the rest stays redeemable later',
      'collateral #2: the RELEASE pays out once relayed to the spoke (the agent does it; by hand: docs/RUNBOOK.md, section 3)',
    ]);
  });

  it('pays out to another recipient while the treasury keeps signing', async () => {
    const steps = commands(await report(world()), OTHER);
    expect(steps[0]).toContain(`"withdrawReserves(uint256,address)" ${3n * E18} ${OTHER}`);
    // Shares are withdrawn to the treasury (it must own them to redeem), then redeemed to the recipient.
    expect(steps[2]).toContain(`0 ${2n * 10n ** 24n} ${TREASURY} "[]"`);
    expect(steps[3]).toContain(`"redeem(uint256,address,address)" ${2n * 10n ** 24n} ${OTHER} ${TREASURY}`);
    expect(steps[4]).toContain(`1 ${10n ** 15n} ${OTHER} "[]"`);
    expect(steps[5]).toContain(pad(OTHER, { size: 32 }));
  });

  it('notes a separate treasury key and treasury debt', async () => {
    const w = world();
    w.owner = OTHER;
    w.debtValue = 5n * E18;
    const { notes } = collectionPlan(await report(w));
    expect(notes).toContain('reserves are withdrawn by the owner key, custody balances by the treasury key');
    expect(notes).toContain('the treasury account has debt: collateral withdrawals need price updates and must keep it within its borrow limit');
  });

  it('has nothing to do when nothing has accrued', async () => {
    const w = world();
    for (const p of Object.values(w.pools)) Object.assign(p, { totalReserves: 0n, totalBorrows: 0n });
    w.treasuryBalances = [0n, 0n, 0n, 0n];
    expect(collectionPlan(await report(w))).toEqual({ steps: [], notes: [] });
  });
});
