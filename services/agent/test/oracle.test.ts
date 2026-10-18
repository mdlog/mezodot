import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, sliceHex, type Hex } from 'viem';
import { PRICE_KEYS, PRICE_SYMBOLS, SOURCE_TAG, type OracleState, type OracleStatus, type PriceSymbol } from '@mezodot/sdk';
import { OracleRelay } from '../src/oracle/relay';
import { oracleHealth } from '../src/oracle/watchdog';
import { pythPushPlan } from '../src/oracle/pusher';

const ROUTER = '0x0000000000000000000000000000000000000003';
const SUPRA = '0x443A0f4Da5d2fdC47de3eeD45Af41d399F0E5702';
const PYTH_ID: Record<PriceSymbol, Hex> = {
  MUSD: '0x0617a9b725011a126a2b9fd53563f4236501f32cf76d877644b943394606c6de',
  MEZO: '0x80beaaedbdd228e77c5d62dfcd74b0305674b7e27a5cc6a46e71bd3a696826df',
  ETH: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  USDC: '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
};
const NO_LEG = { source: 0, maxAge: 0, id: `0x${'0'.repeat(64)}` as Hex };
const pair = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const ARR = { type: 'uint256[]' } as const;

/** Router config as deployed on testnet (and mirrored on the devnet). */
const FEEDS: Record<PriceSymbol, { primary: typeof NO_LEG; secondary: typeof NO_LEG }> = {
  MUSD: { primary: { source: 1, maxAge: 3_900, id: PYTH_ID.MUSD }, secondary: NO_LEG },
  MEZO: { primary: { source: 1, maxAge: 3_900, id: PYTH_ID.MEZO }, secondary: NO_LEG },
  ETH: { primary: { source: 1, maxAge: 120, id: PYTH_ID.ETH }, secondary: { source: 2, maxAge: 120, id: pair(19) } },
  USDC: { primary: { source: 1, maxAge: 3_900, id: PYTH_ID.USDC }, secondary: { source: 2, maxAge: 120, id: pair(89) } },
};

/** Fake hub client: router reads, MockSupraPull-style proof verification, latest block time. */
function fakeClient(blockTime: bigint, calls: string[] = []) {
  const symbolOf = (key: Hex) => PRICE_SYMBOLS.find((s) => PRICE_KEYS[s] === key)!;
  return {
    readContract: async ({ functionName, args }: { functionName: string; args: [Hex] }) => {
      const s = functionName === 'sources' || functionName === 'latest' ? 'MUSD' : symbolOf(args[0]);
      if (functionName === 'feeds') return { ...FEEDS[s], maxConfBps: 500, maxDivergenceBps: 150 };
      if (functionName === 'getPriceInfo') return s === 'MUSD' ? [true, 10n ** 18n, blockTime + 3_000n] : [false, 0n, 0n];
      if (functionName === 'getPriceUnsafe') return [0n, 0n];
      if (functionName === 'sources') return `0x${String(args[0]).padStart(40, '0')}`;
      if (functionName === 'latest') return [0n, 0n, 0n];
      throw new Error(functionName);
    },
    simulateContract: async ({ functionName, args }: { functionName: string; args: [Hex] }) => {
      calls.push(functionName);
      const [pairs, prices, timestamp, decimal] = decodeAbiParameters([ARR, ARR, ARR, ARR], args[0]);
      return { result: { pairs, prices, timestamp, decimal, round: timestamp } };
    },
    getBlock: async () => ({ timestamp: blockTime }),
  };
}

const ctxFor = (env: 'devnet' | 'testnet', client: unknown) =>
  ({
    config: { env },
    hub: {
      network: env === 'devnet' ? 'devnet-hub' : 'mezo-testnet',
      client,
      wallet: null,
      deployment: { contracts: { oracleRouter: ROUTER, supraPull: SUPRA } },
    },
    spokes: [],
    log: () => {},
  }) as never;

describe('OracleRelay', () => {
  it('devnet: Supra-leg symbols get one mock Supra proof, Pyth-only symbols get MockPyth payloads', async () => {
    const now = 1_792_263_654_000;
    const relay = new OracleRelay(ctxFor('devnet', fakeClient(1_792_263_600n)), fetch, () => now);
    const u = await relay.update(['MEZO', 'ETH']);
    expect(u.missing).toEqual([]);
    expect(u.updates).toHaveLength(2);
    // Supra proof first, covering every Supra pair (ETH 19, USDC 89), stamped at the later of chain and wall time.
    expect(sliceHex(u.updates[0], 0, 1)).toBe('0x02');
    const [pairs, prices, timestamps] = decodeAbiParameters([ARR, ARR, ARR, ARR], sliceHex(u.updates[0], 1));
    expect(pairs).toEqual([19n, 89n]);
    expect(prices).toEqual([320_000_000_000n, 100_000_000n]);
    expect(timestamps).toEqual([1_792_263_654_000n, 1_792_263_654_000n]);
    expect(u.prices.ETH).toEqual({ price: 3_200, publishTime: 1_792_263_654, source: 'supra' });
    expect(u.prices.USDC).toBeUndefined(); // not requested
    // MockPyth payload for MEZO, tagged PYTH, with a realistic confidence interval.
    expect(sliceHex(u.updates[1], 0, 1)).toBe('0x01');
    expect(sliceHex(u.updates[1], 1, 33)).toBe(PYTH_ID.MEZO);
    expect(u.prices.MEZO?.source).toBe('pyth');
  });

  it('devnet: mock prices can be moved (e2e liquidations) and invalidate cached proofs', async () => {
    let now = 1_792_263_654_000;
    const relay = new OracleRelay(ctxFor('devnet', fakeClient(1_792_263_654n)), fetch, () => now);
    expect((await relay.update(['ETH'])).prices.ETH?.price).toBe(3_200);
    relay.setMockPrices({ ETH: 2_000, MUSD: -1 });
    expect((await relay.update(['ETH'])).prices.ETH?.price).toBe(2_000);
    now += 1;
    expect(relay.setMockPrices({}).MUSD).toBe(1); // invalid values are ignored
  });

  it('testnet: fetches and verifies one Supra proof; push-only symbols are reported missing', async () => {
    const calls: string[] = [];
    const bodies: unknown[] = [];
    const proof = (await import('@mezodot/sdk')).encodeMockSupraProof([
      { pair: 19, price: 241_298_000_000n, timestampMs: 1_792_263_657_135n, decimals: 8 },
      { pair: 89, price: 99_981_000n, timestampMs: 1_792_263_657_135n, decimals: 8 },
    ]);
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ pair_indexes: [19, 89], proof_bytes: proof.slice(2) }));
    }) as unknown as typeof fetch;
    let now = 1_792_263_658_000;
    const relay = new OracleRelay(ctxFor('testnet', fakeClient(1_792_263_658n, calls)), fetchImpl, () => now);
    const u = await relay.update(['MUSD', 'ETH', 'USDC']);
    expect(bodies).toEqual([{ pair_indexes: [19, 89], chain_type: 'evm' }]);
    expect(calls).toEqual(['verifyOracleProofV2']);
    expect(u.updates).toEqual([`0x02${proof.slice(2)}`]);
    expect(u.prices.ETH?.price).toBeCloseTo(2_412.98, 9);
    expect(u.prices.USDC?.price).toBeCloseTo(0.99981, 9);
    expect(u.missing).toEqual(['MUSD']);
    // Cached for 3 s: another caller in the same window does not hit Supra again.
    now += 2_000;
    await relay.update(['ETH']);
    expect(bodies).toHaveLength(1);
    now += 2_000;
    await relay.update(['ETH']);
    expect(bodies).toHaveLength(2);
  });

  it('testnet: refuses to set mock prices', () => {
    const relay = new OracleRelay(ctxFor('testnet', fakeClient(0n)));
    expect(() => relay.setMockPrices({ ETH: 1 })).toThrow(/devnet/);
  });

  it('prices a risk check: usable on-chain prices plus fresh pull prices, with the updates to attach', async () => {
    const now = 1_792_263_654_000;
    const relay = new OracleRelay(ctxFor('devnet', fakeClient(1_792_263_654n)), fetch, () => now);
    const p = await relay.pricing(['MUSD', 'ETH']);
    expect(p.prices).toEqual({ MUSD: 1, ETH: 3_200 }); // MUSD fresh on-chain (no update), ETH from the proof
    expect(p.update.updates).toHaveLength(1);
    expect(p.unpriced).toEqual([]);
    expect((await relay.pricing([])).update.updates).toEqual([]);
  });
});

describe('oracle health', () => {
  const status = (symbol: PriceSymbol, s: Partial<OracleStatus>): OracleStatus => ({
    symbol,
    feed: { primary: { source: 1, maxAge: 3_900, id: PYTH_ID[symbol] }, secondary: null, maxConfBps: 500, maxDivergenceBps: 0 },
    ok: false,
    price: 0n,
    validUntil: 0,
    lastPrice: 0n,
    publishTime: 0,
    legs: [],
    ...s,
  });
  const supra = { source: SOURCE_TAG.SUPRA, maxAge: 120, id: pair(19) };

  it('classifies each feed and flags unavailable push feeds', () => {
    const oracle: OracleState = {
      MUSD: status('MUSD', { ok: true, price: 10n ** 18n, validUntil: 10_000 + 3_000, lastPrice: 10n ** 18n, publishTime: 10_000 - 900 }),
      MEZO: status('MEZO', { ok: true, price: 3n * 10n ** 15n, validUntil: 10_000 + 500, lastPrice: 3n * 10n ** 15n, publishTime: 10_000 - 3_400 }),
      ETH: status('ETH', { feed: { primary: { source: 1, maxAge: 120, id: PYTH_ID.ETH }, secondary: supra, maxConfBps: 200, maxDivergenceBps: 150 } }),
      USDC: status('USDC', { lastPrice: 10n ** 18n, publishTime: 10_000 - 4_000 }),
    };
    const h = oracleHealth(oracle, 10_000, (s) => s === 'ETH');
    expect(h.feeds.map((f) => [f.symbol, f.status])).toEqual([
      ['MUSD', 'ok'],
      ['MEZO', 'expiring'], // 500 s left of a 3,900 s window (< 20%)
      ['ETH', 'on-demand'], // pull feed: fresh only when a proof is attached
      ['USDC', 'unavailable'], // push feed past its max age and nobody can refresh it
    ]);
    expect(h.feeds[0]).toMatchObject({ price: 1, ageSec: 900, validForSec: 3_000, sources: ['pyth 3900s'] });
    expect(h.feeds[2].sources).toEqual(['pyth 120s', 'supra#19 120s']);
    expect(h.healthy).toBe(false);
  });
});

describe('Pyth pusher plan (only with PYTH_API_KEY)', () => {
  const status = (symbol: PriceSymbol, maxAge: number, s: Partial<OracleStatus>): OracleStatus => ({
    symbol,
    feed: { primary: { source: 1, maxAge, id: PYTH_ID[symbol] }, secondary: null, maxConfBps: 500, maxDivergenceBps: 0 },
    ok: true,
    price: 10n ** 18n,
    validUntil: 0,
    lastPrice: 10n ** 18n,
    publishTime: 0,
    legs: [],
    ...s,
  });

  it('pushes pull-style Pyth legs at half their max age and push feeds when Mezo is ~50 min late', () => {
    const now = 100_000;
    const oracle: OracleState = {
      MUSD: status('MUSD', 3_900, { validUntil: now + 1_000 }), // published 2,900 s ago: Mezo's pusher is on time
      MEZO: status('MEZO', 3_900, { validUntil: now + 800 }), // 3,100 s ago: self-heal
      ETH: status('ETH', 120, { ok: false }), // never pushed
      USDC: status('USDC', 3_900, { feed: null }), // not configured
    };
    expect(pythPushPlan(oracle, now)).toEqual(['MEZO', 'ETH']);
    oracle.ETH = status('ETH', 120, { validUntil: now + 70 });
    expect(pythPushPlan(oracle, now)).toEqual(['MEZO']);
    oracle.ETH = status('ETH', 120, { validUntil: now + 50 });
    expect(pythPushPlan(oracle, now)).toEqual(['MEZO', 'ETH']);
  });
});

describe('Pyth pusher environment', () => {
  it('never runs on the devnet: MockPyth cannot parse real Hermes payloads', async () => {
    const { PythPusher } = await import('../src/oracle/pusher');
    let fetched = 0;
    const fetchImpl = (async () => (fetched++, new Response('{}'))) as unknown as typeof fetch;
    const ctx = {
      config: { env: 'devnet', pythApiKey: 'test-key', hermesUrl: 'http://hermes.test' },
      hub: { wallet: { account: { address: '0x00000000000000000000000000000000000000ee' } }, client: {}, deployment: { contracts: {} } },
      log: () => {},
    };
    const relay = {
      oracle: async () => {
        throw new Error('must not read the router on the devnet');
      },
    };
    const pusher = new PythPusher(ctx as never, relay as never, fetchImpl);
    expect(await pusher.tick()).toEqual({ pushed: [], txHash: null });
    expect(fetched).toBe(0);
  });
});
