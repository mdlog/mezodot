import { encodeMockPythUpdate, toPythInt, type HubDeployment, type PriceSymbol } from '@mezodot/sdk';
import type { Hex } from 'viem';

/**
 * Devnet-only stand-in for Pyth Hermes. Serves `/v2/updates/price/latest` in the Hermes
 * response shape, with MockPyth-encoded update bytes stamped "now". Prices can be changed
 * via `set()` (e.g. to drive a liquidation in the e2e test).
 */
export class MockHermes {
  private prices: Record<PriceSymbol, number> = { MUSD: 1, MEZO: 0.00794, ETH: 3_200, USDC: 1 };
  private readonly bySymbol: Record<PriceSymbol, Hex>;

  constructor(hub: HubDeployment) {
    this.bySymbol = hub.priceFeeds;
  }

  set(update: Partial<Record<PriceSymbol, number>>): Record<PriceSymbol, number> {
    for (const [k, v] of Object.entries(update)) {
      if (k in this.prices && typeof v === 'number' && v > 0) this.prices[k as PriceSymbol] = v;
    }
    return { ...this.prices };
  }

  latest(ids: string[]) {
    const publishTime = Math.floor(Date.now() / 1000);
    const wanted = ids.map((id) => id.toLowerCase().replace(/^0x/, ''));
    const entries = (Object.entries(this.bySymbol) as [PriceSymbol, Hex][]).filter(([, id]) => wanted.includes(id.toLowerCase().slice(2)));
    return {
      binary: { encoding: 'hex', data: entries.map(([s, id]) => encodeMockPythUpdate(id, toPythInt(this.prices[s]), 0n, -8, BigInt(publishTime)).slice(2)) },
      parsed: entries.map(([s, id]) => ({
        id: id.slice(2),
        price: { price: toPythInt(this.prices[s]).toString(), conf: '0', expo: -8, publish_time: publishTime },
      })),
    };
  }
}
