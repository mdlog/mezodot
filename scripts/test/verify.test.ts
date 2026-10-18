import { describe, expect, it } from 'vitest';
import { toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex, type PublicClient } from 'viem';
import {
  PRICE_KEYS,
  PRICE_SYMBOLS,
  keeperGatewayAbi,
  leverageManagerAbi,
  oracleRouterAbi,
  pTokenAbi,
  spokeGatewayAbi,
  swapLeverageManagerAbi,
  toBytes32,
  vaultManagerAbi,
  wormholeAdapterAbi,
  type HubDeployment,
  type PriceSymbol,
  type SpokeDeployment,
} from '../../packages/sdk/src/index';
import { expectationsFromEnv, missingFunctions, selectorPush, verifyEnvironment, type Expectations, type Report } from '../lib/verify';

const A = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}`;
const HUB = {
  vaultManager: A(1),
  oracleRouter: A(2),
  wormholeAdapter: A(3),
  leverageManager: A(4),
  keeperGateway: A(5),
  pMUSD: A(6),
  pMEZO: A(7),
  swapLeverageManager: A(8),
  tigrisPool: A(9),
  tigrisRouter: A(10),
  tigrisFactory: A(11),
  wormhole: A(12),
  pyth: A(13),
  supraPull: A(14),
};
const MUSD = A(16);
const MEZO = A(17);
const BTC = A(18);
const PYTH_SOURCE = A(19);
const SUPRA_SOURCE = A(20);
const IRM = A(21);
const GATEWAY = A(33);
const SPOKE_WORMHOLE = A(34);
const WETH = A(35);
const USDC = A(36);
const OWNER = A(0xaa);
const E18 = 10n ** 18n;
const MAX = 2n ** 256n - 1n;

const PYTH_IDS = Object.fromEntries(PRICE_SYMBOLS.map((s, i) => [s, `0x${(i + 1).toString(16).padStart(64, '0')}`])) as Record<PriceSymbol, Hex>;
const SUPRA = { ETH: 19, USDC: 89, BTC: 18 } as Partial<Record<PriceSymbol, number>>;

const hubDeployment: HubDeployment = {
  network: 'devnet-hub',
  role: 'hub',
  chainId: 31337,
  wormholeChainId: 50,
  startBlock: 10,
  contracts: HUB,
  tokens: { MUSD, MEZO, BTC },
  priceFeeds: PYTH_IDS as HubDeployment['priceFeeds'],
};
const spokeDeployment: SpokeDeployment = {
  network: 'devnet-spoke',
  role: 'spoke',
  chainId: 31338,
  wormholeChainId: 10004,
  startBlock: 10,
  contracts: { spokeGateway: GATEWAY, wormhole: SPOKE_WORMHOLE },
  tokens: { WETH, USDC },
};

/** Bytecode whose dispatcher pushes every selector of `abi` (what solc emits), optionally without some functions. */
const codeFor = (abi: Abi, without: string[] = []): Hex =>
  `0x${abi
    .filter((f): f is AbiFunction => f.type === 'function' && !without.includes(f.name))
    .map((f) => selectorPush(toFunctionSelector(f)))
    .join('')}`;

const leg = (source: number, maxAge: number, id: Hex) => ({ source, maxAge, id });
const NO_LEG = leg(0, 0, `0x${'0'.repeat(64)}`);
const pairId = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

type Collateral = {
  enabled: boolean;
  isRemote: boolean;
  isShare: boolean;
  token: Address;
  chainId: number;
  remoteToken: Hex;
  decimals: number;
  priceKey: Hex;
  ltvBps: number;
  ltBps: number;
  bonusBps: number;
  cap: bigint;
};
const local = (token: Address, isShare: boolean, key: PriceSymbol): Collateral => ({
  enabled: true,
  isRemote: false,
  isShare,
  token,
  chainId: 0,
  remoteToken: `0x${'0'.repeat(64)}`,
  decimals: 18,
  priceKey: PRICE_KEYS[key],
  ltvBps: 7000,
  ltBps: 7800,
  bonusBps: 500,
  cap: MAX,
});
const remote = (token: Address, decimals: number, key: PriceSymbol): Collateral => ({
  ...local('0x0000000000000000000000000000000000000000', false, key),
  isRemote: true,
  chainId: 10004,
  remoteToken: toBytes32(token),
  decimals,
});

/** A consistent devnet-like hub + one spoke; tests break one thing at a time. */
function world() {
  return {
    hubCode: {
      [HUB.vaultManager]: codeFor(vaultManagerAbi),
      [HUB.oracleRouter]: codeFor(oracleRouterAbi),
      [HUB.wormholeAdapter]: codeFor(wormholeAdapterAbi),
      [HUB.leverageManager]: codeFor(leverageManagerAbi),
      [HUB.keeperGateway]: codeFor(keeperGatewayAbi),
      [HUB.pMUSD]: codeFor(pTokenAbi),
      [HUB.pMEZO]: codeFor(pTokenAbi),
      [HUB.swapLeverageManager]: codeFor(swapLeverageManagerAbi),
      ...Object.fromEntries(
        [HUB.tigrisPool, HUB.tigrisRouter, HUB.tigrisFactory, HUB.wormhole, HUB.pyth, HUB.supraPull, MUSD, MEZO, BTC, IRM].map((a) => [a, '0x6080']),
      ),
    } as Record<string, Hex | undefined>,
    spokeCode: { [GATEWAY]: codeFor(spokeGatewayAbi), [SPOKE_WORMHOLE]: '0x6080', [WETH]: '0x6080', [USDC]: '0x6080' } as Record<string, Hex | undefined>,
    treasury: OWNER,
    liquidationFeeBps: 1000,
    collaterals: [local(HUB.pMUSD, true, 'MUSD'), local(HUB.pMEZO, true, 'MEZO'), local(BTC, false, 'BTC'), remote(WETH, 18, 'ETH'), remote(USDC, 6, 'USDC')],
    feeds: Object.fromEntries(
      PRICE_SYMBOLS.map((s) => [
        s,
        {
          primary: leg(1, s === 'ETH' ? 120 : 3900, PYTH_IDS[s]),
          secondary: SUPRA[s] ? leg(2, 120, pairId(SUPRA[s]!)) : NO_LEG,
          maxConfBps: 500,
          maxDivergenceBps: SUPRA[s] ? 150 : 0,
        },
      ]),
    ) as Record<PriceSymbol, { primary: ReturnType<typeof leg>; secondary: ReturnType<typeof leg>; maxConfBps: number; maxDivergenceBps: number }>,
    pair: HUB.tigrisPool as Address | Error,
    factoryPool: HUB.tigrisPool,
    poolQuote: 12_000n,
    routerQuote: 12_000n,
    spokeEmitter: toBytes32(GATEWAY),
    hubEmitter: toBytes32(HUB.wormholeAdapter),
    spokeHubChainId: 50,
    locked: { [WETH]: 5n * E18, [USDC]: 0n } as Record<string, bigint>,
    credited: { 3: 5n * E18 } as Record<number, bigint>,
  };
}
type World = ReturnType<typeof world>;
type Call = { address: Address; functionName: string; args?: readonly unknown[] };

function fakeClient(chainId: number, code: Record<string, Hex | undefined>, read: (c: Call) => unknown): PublicClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => 1_000n,
    getBalance: async () => 0n,
    getCode: async ({ address }: { address: Address }) => code[address],
    readContract: async (c: Call) => {
      const value = read(c);
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`fake: no ${c.functionName} on ${c.address}`);
      return value;
    },
  } as unknown as PublicClient;
}

function hubReads(w: World) {
  const ownable: Record<string, unknown> = { owner: OWNER, pendingOwner: '0x0000000000000000000000000000000000000000' };
  return ({ address, functionName: fn, args = [] }: Call): unknown => {
    const symbolOf = (key: unknown) => PRICE_SYMBOLS.find((s) => PRICE_KEYS[s] === key)!;
    switch (address) {
      case HUB.vaultManager:
        return {
          ...ownable,
          oracle: HUB.oracleRouter,
          adapter: HUB.wormholeAdapter,
          treasury: w.treasury,
          liquidationFeeBps: w.liquidationFeeBps,
          MAX_LIQUIDATION_FEE_BPS: 5000,
          paused: false,
          marketCount: 2n,
          markets: [
            { pool: HUB.pMUSD, priceKey: PRICE_KEYS.MUSD, decimals: 18, enabled: true },
            { pool: HUB.pMEZO, priceKey: PRICE_KEYS.MEZO, decimals: 18, enabled: true },
          ][Number(args[0])],
          collateralCount: BigInt(w.collaterals.length),
          collaterals: w.collaterals[Number(args[0])],
          remoteCollateralId: BigInt(w.collaterals.findIndex((c) => c.isRemote && c.chainId === args[0] && c.remoteToken === args[1]) + 1),
          totalCollateral: w.credited[Number(args[0])] ?? 0n,
        }[fn];
      case HUB.oracleRouter:
        return {
          ...ownable,
          sources: args[0] === 1 ? PYTH_SOURCE : SUPRA_SOURCE,
          feeds: w.feeds[symbolOf(args[0])],
          getPriceInfo: [true, E18, 2_000_000_000n],
        }[fn];
      case PYTH_SOURCE:
        return fn === 'pyth' ? HUB.pyth : undefined;
      case SUPRA_SOURCE:
        return fn === 'pull' ? HUB.supraPull : undefined;
      case HUB.wormholeAdapter:
        return { ...ownable, vaultManager: HUB.vaultManager, wormhole: HUB.wormhole, localChainId: 50, consistencyLevel: 1, spokeEmitter: w.spokeEmitter }[fn];
      case HUB.wormhole:
        return fn === 'chainId' ? 50 : undefined;
      case HUB.pMUSD:
      case HUB.pMEZO:
        return {
          ...ownable,
          vaultManager: HUB.vaultManager,
          asset: address === HUB.pMUSD ? MUSD : MEZO,
          reserveFactor: E18 / 10n,
          MAX_RESERVE_FACTOR: (3n * E18) / 10n,
          supplyCap: 5_000_000n * E18,
          borrowCap: 4_000_000n * E18,
          paused: false,
          interestRateModel: IRM,
          cash: 100n * E18,
          totalBorrows: 0n,
          totalReserves: 0n,
          balanceOf: 10n ** 24n,
        }[fn];
      case MUSD:
      case MEZO:
      case BTC:
        return { decimals: 18, balanceOf: 0n }[fn];
      case HUB.leverageManager:
        return { vaultManager: HUB.vaultManager, pool: HUB.pMUSD, asset: MUSD, marketId: 0n, collateralId: 0n }[fn];
      case HUB.keeperGateway:
        return { vaultManager: HUB.vaultManager, adapter: HUB.wormholeAdapter }[fn];
      case HUB.swapLeverageManager:
        return { vaultManager: HUB.vaultManager, pool: HUB.pMUSD, debtAsset: MUSD, collateral: BTC, marketId: 0n, collateralId: 2n, pair: w.pair }[fn];
      case HUB.tigrisFactory:
        return fn === 'getPool' ? w.factoryPool : undefined;
      case HUB.tigrisPool:
        return { token0: MUSD, token1: BTC, stable: false, getAmountOut: w.poolQuote }[fn];
      case HUB.tigrisRouter:
        return fn === 'getAmountsOut' ? [args[0], w.routerQuote] : undefined;
      default:
        return undefined;
    }
  };
}

function spokeReads(w: World) {
  return ({ address, functionName: fn, args = [] }: Call): unknown => {
    switch (address) {
      case GATEWAY:
        return {
          owner: OWNER,
          pendingOwner: '0x0000000000000000000000000000000000000000',
          hubEmitter: w.hubEmitter,
          hubChainId: w.spokeHubChainId,
          localChainId: 10004,
          wormhole: SPOKE_WORMHOLE,
          paused: false,
          tokens: [true, args[0] === WETH ? 100n * E18 : 250_000n * 10n ** 6n],
          locked: w.locked[args[0] as string],
        }[fn];
      case SPOKE_WORMHOLE:
        return fn === 'chainId' ? 10004 : undefined;
      case WETH:
      case USDC:
        return { decimals: address === WETH ? 18 : 6, balanceOf: w.locked[address] }[fn];
      default:
        return undefined;
    }
  };
}

async function verify(w: World, expectations: Expectations = expectationsFromEnv({})): Promise<Report> {
  const hub = { network: 'devnet-hub' as const, deployment: hubDeployment, client: fakeClient(31337, w.hubCode, hubReads(w)) };
  const spoke = { network: 'devnet-spoke' as const, deployment: spokeDeployment, client: fakeClient(31338, w.spokeCode, spokeReads(w)) };
  return verifyEnvironment(hub, [spoke], expectations);
}

const failures = (r: Report) => r.findings.filter((f) => f.status === 'fail');
const failed = (r: Report, check: string) => failures(r).find((f) => f.check === check);

describe('selectors in bytecode', () => {
  it('pushes selectors the way solc does, dropping leading zero bytes', () => {
    expect(selectorPush('0xa9059cbb')).toBe('63a9059cbb');
    expect(selectorPush('0x00fdd58e')).toBe('62fdd58e');
    expect(selectorPush('0x0000ab12')).toBe('61ab12');
  });

  it('names the ABI functions a deployed contract does not implement', () => {
    expect(missingFunctions(codeFor(vaultManagerAbi), vaultManagerAbi)).toEqual([]);
    expect(missingFunctions(codeFor(vaultManagerAbi, ['treasury', 'repayWithCollateral']), vaultManagerAbi)).toEqual([
      'repayWithCollateral(address,uint256,uint256,uint256)',
      'treasury()',
    ]);
  });

  it('ignores a selector found off an instruction boundary', () => {
    // "63a9059cbb" starting at an odd nibble: not an instruction, so transfer() counts as missing.
    const abi = [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { name: 'to', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ] as const;
    expect(missingFunctions('0x063a9059cbb0', abi)).toEqual(['transfer(address,uint256)']);
    expect(missingFunctions('0x0063a9059cbb', abi)).toEqual([]);
  });
});

describe('verifyEnvironment', () => {
  it('passes a consistent hub and spoke', async () => {
    const r = await verify(world());
    expect(failures(r)).toEqual([]);
    expect(r.count('pass')).toBeGreaterThan(120);
  });

  it('flags a leverage desk bound to a pool other than the factory MUSD/BTC pool', async () => {
    const w = world();
    w.pair = A(0x99);
    const r = await verify(w);
    expect(failed(r, 'SwapLeverageManager.pair() = contracts.tigrisPool')?.detail).toContain(A(0x99));
    expect(failed(r, 'TigrisFactory.getPool(MUSD, BTC, false)')).toBeDefined();
  });

  it('records a reverting getter as a failure and keeps checking', async () => {
    const w = world();
    w.pair = new Error('execution reverted');
    const r = await verify(w);
    expect(failed(r, 'SwapLeverageManager.pair()')?.detail).toBe('call failed: execution reverted');
    // Later sections still ran.
    expect(r.findings.some((f) => f.section === 'devnet-spoke SpokeGateway' && f.status === 'pass')).toBe(true);
  });

  it('flags missing code and contracts older than the SDK ABI', async () => {
    const w = world();
    w.hubCode[HUB.keeperGateway] = undefined;
    w.hubCode[HUB.vaultManager] = codeFor(vaultManagerAbi, ['treasury']);
    const r = await verify(w);
    expect(failed(r, 'devnet-hub contracts.keeperGateway')?.detail).toBe(`no code at ${HUB.keeperGateway}`);
    expect(failed(r, 'devnet-hub VaultManager implements the SDK ABI')?.detail).toContain('treasury()');
  });

  it('flags hub ⇄ spoke links that do not point at each other', async () => {
    const w = world();
    w.hubEmitter = toBytes32(A(0x77));
    w.spokeHubChainId = 51;
    w.spokeEmitter = toBytes32(A(0x78));
    const r = await verify(w);
    expect(failed(r, 'SpokeGateway.hubEmitter()')).toBeDefined();
    expect(failed(r, 'SpokeGateway.hubChainId()')?.detail).toBe('expected 50, got 51');
    expect(failed(r, 'WormholeAdapter.spokeEmitter(10004)')).toBeDefined();
  });

  it('flags a collateral list that does not match the deployment', async () => {
    const w = world();
    w.collaterals[2] = local(BTC, true, 'BTC');
    w.collaterals.pop(); // the spoke's USDC was never registered
    const r = await verify(w);
    expect(failed(r, 'VaultManager.collateralCount()')?.detail).toBe('expected 5, got 4');
    expect(failed(r, 'collateral 2 (BTC) kind')?.detail).toBe('expected plain, got share');
    expect(failed(r, 'collateral devnet-spoke USDC')?.detail).toBe('not listed in VaultManager');
    expect(failed(r, 'SwapLeverageManager collateral 2')).toBeDefined();
  });

  it('flags hub credit above what the spoke holds locked', async () => {
    const w = world();
    w.credited[3] = 6n * E18;
    const r = await verify(w);
    expect(failed(r, 'WETH hub credit ≤ locked')?.detail).toBe('hub credits 6000000000000000000, but only 5000000000000000000 is locked on devnet-spoke');
  });

  it('flags router quotes that disagree with the pool (wrong router or factory)', async () => {
    const w = world();
    w.routerQuote = 11_000n;
    const r = await verify(w);
    expect(failed(r, 'TigrisRouter.getAmountsOut(1 MUSD) = pool quote')?.detail).toBe('expected 12000, got 11000');
  });

  it('defaults the treasury to the owner and accepts EXPECTED_TREASURY', async () => {
    const w = world();
    w.treasury = A(0xbb);
    expect(failed(await verify(w), 'VaultManager.treasury()')?.detail).toBe(`expected ${OWNER}, got ${A(0xbb)}`);
    expect(failed(await verify(w, expectationsFromEnv({ EXPECTED_TREASURY: A(0xbb) })), 'VaultManager.treasury()')).toBeUndefined();
  });

  it('compares the deploy environment once it is loaded', async () => {
    const env = { PYTH: HUB.pyth, SUPRA_PULL: HUB.supraPull, ETH_SUPRA_PAIR: '19', BTC_SUPRA_PAIR: '18', MUSD_MAX_AGE: '3600', LIQUIDATION_FEE_BPS: '500' };
    const r = await verify(world(), expectationsFromEnv(env));
    expect(failed(r, 'VaultManager.liquidationFeeBps()')?.detail).toBe('expected 500, got 1000');
    expect(failed(r, 'feed MUSD Pyth max age')?.detail).toBe('expected 3600, got 3900');
    // USDC has a Supra leg on-chain that the loaded environment does not configure.
    expect(failed(r, 'feed USDC Supra pair')).toBeDefined();
    expect(failed(r, 'devnet-hub.json contracts.pyth = deploy input')).toBeUndefined(); // inputs are per testnet name only
  });
});

describe('expectationsFromEnv', () => {
  it('reads caps, the Tigris curve and the seed switch', () => {
    const e = expectationsFromEnv({
      MUSD_SUPPLY_CAP: '5000000000000000000000000',
      BTC_COLLATERAL_CAP: '0x15af1d78b58c40000',
      TIGRIS_STABLE: 'true',
      SEED_AMOUNT: '0',
    });
    expect(e.caps).toEqual({ MUSD_SUPPLY_CAP: 5_000_000n * E18, BTC_COLLATERAL_CAP: 25n * E18 });
    expect(e.tigrisStable).toBe(true);
    expect(e.seeded).toBe(false);
    expect(e.feeds.MUSD).toEqual({ maxAge: undefined, maxConfBps: undefined, supraPair: undefined, supraMaxAge: undefined, divergenceBps: undefined });
  });

  it('maps contracts/.env.example names to deployment JSON paths per network', () => {
    const e = expectationsFromEnv({ MUSD: MUSD, MEZO_WORMHOLE: HUB.wormhole, BASE_WETH: WETH, BTC_FEED: PYTH_IDS.BTC });
    expect(e.inputs['mezo-testnet']).toEqual({ 'tokens.MUSD': MUSD, 'contracts.wormhole': HUB.wormhole, 'priceFeeds.BTC': PYTH_IDS.BTC });
    expect(e.inputs['base-sepolia']).toEqual({ 'tokens.WETH': WETH });
  });

  it('rejects malformed values instead of comparing against them', () => {
    expect(() => expectationsFromEnv({ MUSD_MAX_AGE: '1h' })).toThrow('MUSD_MAX_AGE must be a non-negative integer');
    expect(() => expectationsFromEnv({ WETH_CAP: '100e18' })).toThrow('WETH_CAP must be an integer amount in token wei');
    expect(() => expectationsFromEnv({ EXPECTED_OWNER: '0x1234' })).toThrow('EXPECTED_OWNER must be an address');
    expect(() => expectationsFromEnv({ TIGRIS_STABLE: 'yes' })).toThrow('TIGRIS_STABLE must be true or false');
  });
});
