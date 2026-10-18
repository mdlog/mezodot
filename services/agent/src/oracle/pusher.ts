import { PRICE_SYMBOLS, SOURCE_TAG, fetchPriceUpdate, oracleRouterAbi, tagUpdate, type OracleState, type PriceSymbol } from '@mezodot/sdk';
import type { Hex } from 'viem';
import type { Context } from '../context';
import type { OracleRelay } from './relay';
import { writeWithBuffer } from '../tx';

/** Push feeds are refreshed once this little validity is left (≈ Mezo's hourly pusher running 50 min late). */
const PUSH_FEED_LEAD_SEC = 900;
/** Legs with a max age up to this are pull-style (ETH: 120 s) and are kept fresh at half their max age. */
const PULL_STYLE_MAX_AGE = 300;
/** Pyth keys are entitled feed by feed (HTTP 403 "Not entitled"); such feeds are retried hourly. */
const NOT_ENTITLED_RETRY_MS = 60 * 60_000;

export type PusherStatus = {
  enabled: boolean;
  /** Feeds the configured key is not entitled to (skipped until their retry time). */
  notEntitled: PriceSymbol[];
  lastPush: { symbols: PriceSymbol[]; txHash: Hex; at: number } | null;
};

const errorLine = (err: unknown): string => (err instanceof Error ? err.message.split('\n')[0] : String(err));

/** Symbols whose Pyth primary leg should be pushed now. */
export function pythPushPlan(oracle: OracleState, nowSec: number): PriceSymbol[] {
  return PRICE_SYMBOLS.filter((s) => {
    const leg = oracle[s].feed?.primary;
    if (!leg || leg.source !== SOURCE_TAG.PYTH) return false;
    if (!oracle[s].ok) return true;
    const lead = leg.maxAge <= PULL_STYLE_MAX_AGE ? leg.maxAge / 2 : PUSH_FEED_LEAD_SEC;
    return oracle[s].validUntil - nowSec < lead;
  });
}

/**
 * Optional keyed Pyth pusher (PYTH_API_KEY): posts Hermes updates to Pyth Core on Mezo through the router,
 * keeping ETH's Pyth leg live and refreshing MUSD/MEZO/USDC when Mezo's own pusher lags. The key is used
 * only for the Hermes request; it is never logged or served (Pyth's terms forbid sharing it).
 */
export class PythPusher {
  private readonly notEntitled = new Map<PriceSymbol, number>();
  private lastPush: PusherStatus['lastPush'] = null;

  constructor(
    private readonly ctx: Context,
    private readonly relay: OracleRelay,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  status(): PusherStatus {
    const enabled = Boolean(this.ctx.config.pythApiKey && this.ctx.hub.wallet && this.ctx.config.env !== 'devnet');
    return { enabled, notEntitled: PRICE_SYMBOLS.filter((s) => this.notEntitled.has(s)), lastPush: this.lastPush };
  }

  async tick(): Promise<{ pushed: PriceSymbol[]; txHash: Hex | null }> {
    const { pythApiKey, hermesUrl } = this.ctx.config;
    const { client, wallet, deployment } = this.ctx.hub;
    // The devnet's MockPyth only accepts its own encoding, not real Hermes payloads.
    if (!pythApiKey || !wallet || this.ctx.config.env === 'devnet') return { pushed: [], txHash: null };
    const oracle = await this.relay.oracle();
    const now = this.now();
    const plan = pythPushPlan(oracle, Math.floor(now / 1000)).filter((s) => (this.notEntitled.get(s) ?? 0) <= now);
    if (plan.length === 0) return { pushed: [], txHash: null };
    // One Hermes request per feed: a feed the key does not cover (403) must not block the others.
    const results = await Promise.allSettled(
      plan.map((s) => fetchPriceUpdate(hermesUrl, [oracle[s].feed!.primary.id], this.fetchImpl, { accessToken: pythApiKey })),
    );
    const pushed: PriceSymbol[] = [];
    const tagged: Hex[] = [];
    results.forEach((r, i) => {
      const s = plan[i];
      if (r.status === 'fulfilled') {
        pushed.push(s);
        tagged.push(...r.value.updates.map((u) => tagUpdate(SOURCE_TAG.PYTH, u)));
        this.notEntitled.delete(s);
        return;
      }
      const error = errorLine(r.reason);
      if (/\b403\b/.test(error)) {
        if (!this.notEntitled.has(s)) this.ctx.log('oracle', `Pyth key is not entitled to ${s}; retrying hourly`, { error });
        this.notEntitled.set(s, now + NOT_ENTITLED_RETRY_MS);
      } else {
        this.ctx.log('oracle', `Hermes request for ${s} failed`, { error });
      }
    });
    if (tagged.length === 0) return { pushed: [], txHash: null };
    const router = deployment.contracts.oracleRouter;
    const fee = await client.readContract({ address: router, abi: oracleRouterAbi, functionName: 'updateFee', args: [tagged] });
    const { request } = await client.simulateContract({
      account: wallet.account,
      address: router,
      abi: oracleRouterAbi,
      functionName: 'updatePrices',
      args: [tagged],
      value: fee,
    });
    const txHash = await writeWithBuffer(client, wallet, request);
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new Error(`Pyth push ${txHash} reverted`);
    this.lastPush = { symbols: pushed, txHash, at: now };
    this.ctx.log('oracle', 'pushed Pyth prices', { symbols: pushed, txHash });
    return { pushed, txHash };
  }
}
