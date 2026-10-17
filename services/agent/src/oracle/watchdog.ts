import { PRICE_SYMBOLS, SOURCE_TAG, type FeedLeg, type OracleState, type PriceSymbol } from '@mezodot/sdk';
import type { Context } from '../context';
import type { OracleRelay } from './relay';

/** A feed is "expiring" once less than this share of its longest max age remains. */
const EXPIRING_SHARE = 0.2;

export type FeedHealth = {
  symbol: PriceSymbol;
  /**
   * ok: strict reads succeed. expiring: they do, but the price is close to its max age.
   * on-demand: unavailable until someone attaches a pull update (normal for Supra-only keys).
   * unavailable: nobody can refresh it right now; risk checks touching it revert.
   */
  status: 'ok' | 'expiring' | 'on-demand' | 'unavailable' | 'unconfigured';
  /** Strict price when usable, else the last stored value (USD); null when never published. */
  price: number | null;
  /** Seconds since the newest stored value was published. */
  ageSec: number | null;
  /** Seconds the key stays available (0 when unavailable). */
  validForSec: number;
  sources: string[];
};

export type OracleHealth = { checkedAt: number; healthy: boolean; feeds: FeedHealth[] };

const describeLeg = (leg: FeedLeg): string =>
  leg.source === SOURCE_TAG.SUPRA
    ? `supra#${Number(BigInt(leg.id))} ${leg.maxAge}s`
    : leg.source === SOURCE_TAG.PYTH
      ? `pyth ${leg.maxAge}s`
      : `source${leg.source} ${leg.maxAge}s`;

/** Classifies every feed. `pullable(s)` says whether the relay can refresh `s` on demand. */
export function oracleHealth(oracle: OracleState, nowSec: number, pullable: (s: PriceSymbol) => boolean): OracleHealth {
  const feeds = PRICE_SYMBOLS.map((symbol): FeedHealth => {
    const s = oracle[symbol];
    if (!s.feed) return { symbol, status: 'unconfigured', price: null, ageSec: null, validForSec: 0, sources: [] };
    const legs = [s.feed.primary, ...(s.feed.secondary ? [s.feed.secondary] : [])];
    const window = Math.max(...legs.map((l) => l.maxAge));
    const validForSec = s.ok ? Math.max(0, s.validUntil - nowSec) : 0;
    const status: FeedHealth['status'] = s.ok ? (validForSec < window * EXPIRING_SHARE ? 'expiring' : 'ok') : pullable(symbol) ? 'on-demand' : 'unavailable';
    const value = s.ok ? s.price : s.lastPrice;
    return {
      symbol,
      status,
      price: value > 0n ? Number(value) / 1e18 : null,
      ageSec: s.publishTime > 0 ? Math.max(0, nowSec - s.publishTime) : null,
      validForSec,
      sources: legs.map(describeLeg),
    };
  });
  return { checkedAt: nowSec, healthy: feeds.every((f) => f.status !== 'unavailable'), feeds };
}

/** Polls the router, keeps the latest health report and logs status changes. */
export class OracleWatchdog {
  private last: OracleHealth | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly relay: OracleRelay,
    private readonly now: () => number = Date.now,
  ) {}

  report(): OracleHealth | null {
    return this.last;
  }

  error(): string | null {
    return this.lastError;
  }

  async check(): Promise<OracleHealth> {
    try {
      const oracle = await this.relay.oracle();
      const devnet = this.ctx.config.env === 'devnet';
      const health = oracleHealth(oracle, Math.floor(this.now() / 1000), (s) => {
        const legs = [oracle[s].feed?.primary, oracle[s].feed?.secondary];
        return legs.some((l) => l?.source === SOURCE_TAG.SUPRA) || (devnet && oracle[s].feed?.primary.source === SOURCE_TAG.PYTH);
      });
      for (const f of health.feeds) {
        const before = this.last?.feeds.find((x) => x.symbol === f.symbol)?.status;
        if (before !== f.status && (f.status === 'expiring' || f.status === 'unavailable' || before === 'unavailable')) {
          this.ctx.log('oracle', `${f.symbol} ${f.status}`, { ageSec: f.ageSec, validForSec: f.validForSec, sources: f.sources });
        }
      }
      this.last = health;
      this.lastError = null;
      return health;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message.split('\n')[0] : String(err);
      throw err;
    }
  }
}
