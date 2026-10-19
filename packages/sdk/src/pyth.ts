import { encodeAbiParameters, type Hex } from 'viem';

export type PythPrice = {
  id: Hex;
  /** Price as a decimal number (price × 10^expo). */
  price: number;
  conf: number;
  publishTime: number;
};

export type PriceUpdate = {
  /** Pass as `bytes[] priceUpdate` to risk-checked contract calls. */
  updates: Hex[];
  prices: Record<string, PythPrice>;
};

type HermesResponse = {
  binary: { encoding: string; data: string[] };
  parsed: { id: string; price: { price: string; conf: string; expo: number; publish_time: number } }[];
};

const with0x = (s: string): Hex => (s.startsWith('0x') ? s : `0x${s}`) as Hex;

/** Pyth Hermes. Every request needs a Pyth API key since the 2026-08-26 Pyth Core cutover. */
export const PYTH_HERMES_URL = 'https://hermes.pyth.network';

/**
 * Fetches the latest signed Pyth updates from Hermes. Server-side only: the API key must never reach a
 * browser bundle (VITE_* values are public), and the browser app never calls Hermes.
 * Updates are untagged Pyth payloads; tag them with SOURCE_TAG.PYTH before passing them to OracleRouter.
 */
export async function fetchPriceUpdate(
  hermesUrl: string,
  ids: Hex[],
  fetchImpl: typeof fetch = fetch,
  opts: { accessToken?: string } = {},
): Promise<PriceUpdate> {
  const query = ids.map((id) => `ids[]=${id}`).join('&');
  const headers: Record<string, string> = opts.accessToken ? { authorization: `Bearer ${opts.accessToken}` } : {};
  const res = await fetchImpl(`${hermesUrl}/v2/updates/price/latest?${query}&encoding=hex&parsed=true`, { headers });
  if (!res.ok) throw new Error(`Price service error ${res.status}`);
  const body = (await res.json()) as HermesResponse;
  const prices: Record<string, PythPrice> = {};
  for (const p of body.parsed) {
    const id = with0x(p.id).toLowerCase() as Hex;
    const scale = 10 ** p.price.expo;
    prices[id] = { id, price: Number(p.price.price) * scale, conf: Number(p.price.conf) * scale, publishTime: p.price.publish_time };
  }
  return { updates: body.binary.data.map(with0x), prices };
}

const PRICE = [
  { name: 'price', type: 'int64' },
  { name: 'conf', type: 'uint64' },
  { name: 'expo', type: 'int32' },
  { name: 'publishTime', type: 'uint256' },
] as const;

/** Same bytes as MockPyth.createPriceFeedUpdateData (devnet and tests only). */
export function encodeMockPythUpdate(id: Hex, price: bigint, conf: bigint, expo: number, publishTime: bigint): Hex {
  const p = { price, conf, expo, publishTime };
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          { name: 'id', type: 'bytes32' },
          { name: 'price', type: 'tuple', components: PRICE },
          { name: 'emaPrice', type: 'tuple', components: PRICE },
        ],
      },
    ],
    [{ id, price: p, emaPrice: p }],
  );
}

/** Converts a decimal price to Pyth integer form with exponent −8. */
export const toPythInt = (price: number): bigint => BigInt(Math.round(price * 1e8));
