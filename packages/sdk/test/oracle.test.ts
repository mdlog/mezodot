import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  PRICE_KEYS,
  SOURCE_TAG,
  displayPrices,
  encodeMockSupraProof,
  fetchOracleUpdate,
  fetchPriceUpdate,
  fetchSupraProof,
  positionSymbols,
  pricesAfterUpdate,
  readOracle,
  riskCheckSymbols,
  staleSymbols,
  tagUpdate,
  usablePrices,
  verifySupraProof,
  type HubDeployment,
  type LegState,
  type OracleState,
  type OracleStatus,
  type PositionState,
  type PriceSymbol,
  type ProtocolState,
} from '../src';

// cast abi-encode "f(uint256[],uint256[],uint256[],uint256[])" "[19,89]" "[241298000000,99981000]" \
//   "[1792263657135,1792263657135]" "[8,8]"  (what MockSupraPull decodes)
const MOCK_SUPRA_PROOF =
  '0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000014000000000000000000000000000000000000000000000000000000000000001a00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001300000000000000000000000000000000000000000000000000000000000000590000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000382e7b48800000000000000000000000000000000000000000000000000000000005f596c80000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000001a14b3d16af000000000000000000000000000000000000000000000000000001a14b3d16af000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000008';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('oracle updates', () => {
  it('tags updates for OracleRouter (tag byte ‖ vendor payload)', () => {
    expect(tagUpdate(SOURCE_TAG.SUPRA, '0xabcd')).toBe('0x02abcd');
    expect(tagUpdate(SOURCE_TAG.PYTH, '0x00')).toBe('0x0100');
  });

  it('mock Supra proof matches the abi.encode MockSupraPull decodes', () => {
    expect(
      encodeMockSupraProof([
        { pair: 19, price: 241_298_000_000n, timestampMs: 1_792_263_657_135n, decimals: 8 },
        { pair: 89, price: 99_981_000n, timestampMs: 1_792_263_657_135n, decimals: 8 },
      ]),
    ).toBe(MOCK_SUPRA_PROOF);
  });

  it('fetches a Supra proof with a JSON POST and rejects failures', async () => {
    let url = '';
    let init: RequestInit | undefined;
    const fake = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return json({ pair_indexes: [19, 89], proof_bytes: 'abcd' });
    }) as unknown as typeof fetch;
    expect(await fetchSupraProof('https://supra.test/get_proof', [19, 89], fake)).toBe('0xabcd');
    expect(url).toBe('https://supra.test/get_proof');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ pair_indexes: [19, 89], chain_type: 'evm' });

    const failing = (async () => new Response('bad gateway', { status: 502 })) as unknown as typeof fetch;
    await expect(fetchSupraProof('u', [19], failing)).rejects.toThrow('502');
    const empty = (async () => json({ pair_indexes: [19] })) as unknown as typeof fetch;
    await expect(fetchSupraProof('u', [19], empty)).rejects.toThrow(/no proof/);
  });

  it('verifies a Supra proof by eth_call and normalises prices to WAD', async () => {
    let called: { functionName?: string; args?: unknown[] } = {};
    const client = {
      simulateContract: async (req: { functionName: string; args: unknown[] }) => {
        called = req;
        return {
          result: {
            pairs: [19n, 0n],
            prices: [241_298_000_000n, 81_512_300_000_000_000_000_000n],
            timestamp: [1_792_263_657_135n, 1_792_263_657_000n],
            decimal: [8n, 18n],
            round: [1n, 1n],
          },
        };
      },
    } as unknown as PublicClient;
    expect(await verifySupraProof(client, '0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702', '0x1234')).toEqual([
      { pair: 19, priceWad: 2_412_980_000_000_000_000_000n, publishTime: 1_792_263_657 },
      { pair: 0, priceWad: 81_512_300_000_000_000_000_000n, publishTime: 1_792_263_657 },
    ]);
    expect(called.functionName).toBe('verifyOracleProofV2');
    expect(called.args).toEqual(['0x1234']);
  });

  it('Hermes requests carry an API key only when one is given (server-side pushers)', async () => {
    const auth: (string | null)[] = [];
    const fake = (async (_u: string, i?: RequestInit) => {
      auth.push(new Headers(i?.headers).get('authorization'));
      return json({ binary: { encoding: 'hex', data: [] }, parsed: [] });
    }) as unknown as typeof fetch;
    await fetchPriceUpdate('http://hermes', ['0xff61'], fake);
    await fetchPriceUpdate('http://hermes', ['0xff61'], fake, { accessToken: 'k3y' });
    expect(auth).toEqual([null, 'Bearer k3y']);
  });

  it('asks the agent relay only for the requested symbols', async () => {
    const urls: string[] = [];
    const fake = (async (u: string) => {
      urls.push(u);
      return json({ updates: ['0x02ab'], prices: { ETH: { price: 2_412.98, publishTime: 1_792_263_657, source: 'supra' } }, missing: ['MUSD'] });
    }) as unknown as typeof fetch;
    const u = await fetchOracleUpdate('http://agent:8787', ['MUSD', 'ETH'], fake);
    expect(urls).toEqual(['http://agent:8787/oracle/update?symbols=MUSD,ETH']);
    expect(u.updates).toEqual(['0x02ab']);
    expect(u.prices.ETH?.price).toBe(2_412.98);
    expect(u.missing).toEqual(['MUSD']);
    // Nothing to fetch: no request at all.
    expect(await fetchOracleUpdate('http://agent:8787', [], fake)).toEqual({ updates: [], prices: {}, missing: [] });
    expect(urls).toHaveLength(1);
    const down = (async () => json({ error: 'Supra proof service error 502' }, 502)) as unknown as typeof fetch;
    await expect(fetchOracleUpdate('http://agent:8787', ['ETH'], down)).rejects.toThrow('Supra proof service error 502');
  });
});

describe('price selection', () => {
  const status = (symbol: PriceSymbol, s: Partial<OracleStatus>): OracleStatus => ({
    symbol,
    feed: null,
    ok: false,
    price: 0n,
    validUntil: 0,
    lastPrice: 0n,
    publishTime: 0,
    legs: [],
    ...s,
  });
  const oracle: OracleState = {
    MUSD: status('MUSD', { ok: true, price: 990_000_000_000_000_000n, validUntil: 4_000, lastPrice: 990_000_000_000_000_000n, publishTime: 900 }),
    MEZO: status('MEZO', { ok: true, price: 3_000_000_000_000_000n, validUntil: 1_050, lastPrice: 3_000_000_000_000_000n, publishTime: 800 }),
    ETH: status('ETH', { lastPrice: 2_400_000_000_000_000_000_000n, publishTime: 100 }),
    USDC: status('USDC', {}),
  };

  it('stale = unavailable now or expiring within the margin', () => {
    expect(staleSymbols(oracle, ['MUSD', 'MEZO', 'ETH', 'USDC'], 1_000, 90)).toEqual(['MEZO', 'ETH', 'USDC']);
    expect(staleSymbols(oracle, ['MUSD'], 1_000, 90)).toEqual([]);
  });

  it('usable prices follow VaultManager: strict price, else a fresh pull price, else nothing', () => {
    expect(usablePrices(oracle, { ETH: { price: 2_412.98, publishTime: 999, source: 'supra' } })).toEqual({ MUSD: 0.99, MEZO: 0.003, ETH: 2_412.98 });
    expect(usablePrices(oracle)).toEqual({ MUSD: 0.99, MEZO: 0.003 });
  });

  it('display prices fall back to the newest stored value', () => {
    expect(displayPrices(oracle)).toEqual({ MUSD: 0.99, MEZO: 0.003, ETH: 2_400 });
    expect(displayPrices(oracle, { ETH: { price: 2_412.98, publishTime: 999, source: 'supra' } }).ETH).toBe(2_412.98);
  });

  const protocol = {
    markets: [
      { id: 0, priceKey: PRICE_KEYS.MUSD },
      { id: 1, priceKey: PRICE_KEYS.MEZO },
    ],
    collaterals: [
      { id: 0, priceKey: PRICE_KEYS.MUSD },
      { id: 1, priceKey: PRICE_KEYS.MEZO },
      { id: 2, priceKey: PRICE_KEYS.ETH },
      { id: 3, priceKey: PRICE_KEYS.USDC },
    ],
  } as unknown as ProtocolState;
  const position = (collateral: [number, bigint][], debts: [number, bigint][]) =>
    ({
      collateral: collateral.map(([id, balance]) => ({ id, balance, valueUsd: 0n })),
      debts: debts.map(([marketId, amount]) => ({ marketId, amount })),
    }) as unknown as PositionState;

  it('a risk check reads every held collateral and debt, plus the borrowed asset', () => {
    const p = position(
      [
        [2, 1n],
        [3, 0n],
      ],
      [
        [1, 7n],
        [0, 0n],
      ],
    );
    expect(riskCheckSymbols(protocol, p)).toEqual(['MEZO', 'ETH']);
    expect(riskCheckSymbols(protocol, p, 'MUSD')).toEqual(['MUSD', 'MEZO', 'ETH']);
    expect(riskCheckSymbols(protocol, null, 'ETH')).toEqual(['ETH']);
  });

  it('a debt-free account needs no prices unless it borrows', () => {
    const p = position([[2, 5n]], []);
    expect(riskCheckSymbols(protocol, p)).toEqual([]);
    expect(riskCheckSymbols(protocol, p, 'MUSD')).toEqual(['MUSD', 'ETH']);
    expect(positionSymbols(protocol, p)).toEqual(['ETH']); // what it holds, for display
  });
});

describe('prices after attaching pull updates (keepers)', () => {
  const E18 = 10n ** 18n;
  const leg = (source: number, usable: boolean, price = 0n): LegState => ({ source, maxAge: 120, id: '0x01', price, conf: 0n, publishTime: 0, usable });
  const st = (symbol: PriceSymbol, legs: LegState[], price: bigint): OracleStatus => ({
    symbol,
    feed: { primary: legs[0], secondary: legs[1] ?? null, maxConfBps: 200, maxDivergenceBps: 150 },
    ok: price > 0n,
    price,
    validUntil: 0,
    lastPrice: price,
    publishTime: 0,
    legs,
  });
  const oracle: OracleState = {
    // devnet: Pyth primary refreshed by the relay itself
    MUSD: st('MUSD', [leg(1, true, E18)], E18),
    MEZO: st('MEZO', [leg(1, false)], 0n),
    // Pyth ETH never pushed: the Supra secondary (stored at $3,200) is what the router selects
    ETH: st('ETH', [leg(1, false), leg(2, true, 3_200n * E18)], 3_200n * E18),
    // Pyth USDC fresh (Mezo's push): it stays selected whatever Supra says
    USDC: st('USDC', [leg(1, true, E18), leg(2, false)], E18),
  };

  it('a fresh price counts only where the router would select the refreshed leg', () => {
    const fresh = {
      MUSD: { price: 0.99, publishTime: 1, source: 'pyth' as const },
      ETH: { price: 2_800, publishTime: 1, source: 'supra' as const },
      USDC: { price: 0.97, publishTime: 1, source: 'supra' as const },
    };
    expect(pricesAfterUpdate(oracle, fresh)).toEqual({ MUSD: 0.99, ETH: 2_800, USDC: 1 });
    expect(pricesAfterUpdate(oracle, {})).toEqual({ MUSD: 1, ETH: 3_200, USDC: 1 });
  });
});

describe('readOracle', () => {
  it('reads every leg through its source and marks the usable ones', async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = (s: PriceSymbol) => PRICE_KEYS[s];
    const SOURCES: Record<number, `0x${string}`> = { 1: '0x00000000000000000000000000000000000000a1', 2: '0x00000000000000000000000000000000000000a2' };
    const feeds: Record<string, unknown> = {
      [key('ETH')]: {
        primary: { source: 1, maxAge: 120, id: '0xe7' },
        secondary: { source: 2, maxAge: 120, id: '0x13' },
        maxConfBps: 200,
        maxDivergenceBps: 150,
      },
    };
    const none = { primary: { source: 0, maxAge: 0, id: '0x00' }, secondary: { source: 0, maxAge: 0, id: '0x00' }, maxConfBps: 0, maxDivergenceBps: 0 };
    const client = {
      readContract: async ({ address, functionName, args }: { address: string; functionName: string; args: unknown[] }) => {
        if (functionName === 'feeds') return feeds[args[0] as string] ?? none;
        if (functionName === 'getPriceInfo') return args[0] === key('ETH') ? [true, 2_400n * 10n ** 18n, BigInt(now + 100)] : [false, 0n, 0n];
        if (functionName === 'getPriceUnsafe') return args[0] === key('ETH') ? [2_400n * 10n ** 18n, BigInt(now - 20)] : [0n, 0n];
        if (functionName === 'sources') return SOURCES[args[0] as number];
        if (functionName === 'latest') {
          // Pyth leg: 2 h old (unusable); Supra leg: 20 s old (usable)
          if (address === SOURCES[1]) return [2_390n * 10n ** 18n, 0n, BigInt(now - 7_200)];
          return [2_400n * 10n ** 18n, 0n, BigInt(now - 20)];
        }
        throw new Error(functionName);
      },
    } as unknown as PublicClient;
    const hub = { contracts: { oracleRouter: '0x0000000000000000000000000000000000000003' } } as unknown as HubDeployment;
    const o = await readOracle(client, hub);
    expect(o.ETH.ok).toBe(true);
    expect(o.ETH.legs.map((l) => [l.source, l.usable])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(o.ETH.legs[1].price).toBe(2_400n * 10n ** 18n);
    expect(o.MUSD.feed).toBeNull();
    expect(o.MUSD.legs).toEqual([]);
  });
});
