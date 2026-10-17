import { PRICE_SYMBOLS, SOURCE_TAG, fetchPriceUpdate, oracleRouterAbi, tagUpdate, type OracleState, type PriceSymbol } from '@mezodot/sdk';
import type { Hex } from 'viem';
import type { Context } from '../context';
import type { OracleRelay } from './relay';

/** Push feeds are refreshed once this little validity is left (≈ Mezo's hourly pusher running 50 min late). */
const PUSH_FEED_LEAD_SEC = 900;
/** Legs with a max age up to this are pull-style (ETH: 120 s) and are kept fresh at half their max age. */
const PULL_STYLE_MAX_AGE = 300;

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
  constructor(
    private readonly ctx: Context,
    private readonly relay: OracleRelay,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<{ pushed: PriceSymbol[]; txHash: Hex | null }> {
    const { pythApiKey, hermesUrl } = this.ctx.config;
    const { client, wallet, deployment } = this.ctx.hub;
    if (!pythApiKey || !wallet) return { pushed: [], txHash: null };
    const oracle = await this.relay.oracle();
    const plan = pythPushPlan(oracle, Math.floor(this.now() / 1000));
    if (plan.length === 0) return { pushed: [], txHash: null };
    const ids = plan.map((s) => oracle[s].feed!.primary.id);
    const { updates } = await fetchPriceUpdate(hermesUrl, ids, this.fetchImpl, { accessToken: pythApiKey });
    const tagged = updates.map((u) => tagUpdate(SOURCE_TAG.PYTH, u));
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
    const txHash = await wallet.writeContract(request);
    await client.waitForTransactionReceipt({ hash: txHash });
    this.ctx.log('oracle', 'pushed Pyth prices', { symbols: plan, txHash });
    return { pushed: plan, txHash };
  }
}
