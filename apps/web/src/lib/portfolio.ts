import { pTokenUnits, symbolForPriceKey, type MarketState, type ProtocolState, type UsdPrices, type ValuedPosition } from '@mezodot/sdk';

/** A pool the account holds pTokens of, in underlying units: those in the wallet and those posted as collateral. */
export type SupplyRow = {
  market: MarketState;
  /** Undefined while the wallet balances cannot be read. */
  walletUnits: number | undefined;
  postedUnits: number;
  /** Wallet and posted together, at the pool asset's price; undefined while the wallet is unknown. */
  valueUsd: number | undefined;
};

export type Holdings = {
  supplies: SupplyRow[];
  /** Every pToken held, posted or not: the deposits earning the supply rate. Null while the wallet is unknown. */
  suppliedUsd: number | null;
  /** pTokens in the wallet, plus all posted collateral (hub and spokes), less debt. Null while the wallet is unknown. */
  netWorthUsd: number | null;
};

/**
 * What the account holds in Mezodot. Posted pTokens are collateral (VaultManager holds them), so they count once,
 * through `valued`, and the pTokens still in the wallet are added on top. Tokens the wallet holds without supplying
 * them (MUSD, BTC) are not part of it. `walletTokens` are the hub balances by symbol (WalletBalances.hub.tokens).
 */
export function accountHoldings(
  protocol: ProtocolState,
  valued: ValuedPosition,
  walletTokens: Record<string, bigint> | undefined,
  prices: UsdPrices,
): Holdings {
  let walletUsd = 0;
  const supplies = protocol.markets.flatMap((market): SupplyRow[] => {
    const symbol = symbolForPriceKey(market.priceKey);
    const price = symbol ? (prices[symbol] ?? 0) : 0;
    const posted = valued.collateral.find((c) => c.collateral.isShare && c.collateral.token.toLowerCase() === market.pool.toLowerCase());
    const postedUnits = posted?.units ?? 0;
    const walletUnits = walletTokens ? pTokenUnits(market, walletTokens[market.receiptSymbol] ?? 0n) : undefined;
    if (postedUnits === 0 && !walletUnits) return [];
    walletUsd += (walletUnits ?? 0) * price;
    return [{ market, walletUnits, postedUnits, valueUsd: walletUnits === undefined ? undefined : (walletUnits + postedUnits) * price }];
  });
  if (!walletTokens) return { supplies, suppliedUsd: null, netWorthUsd: null };
  return {
    supplies,
    suppliedUsd: supplies.reduce((sum, s) => sum + (s.valueUsd ?? 0), 0),
    netWorthUsd: walletUsd + valued.collateralUsd - valued.debtUsd,
  };
}
