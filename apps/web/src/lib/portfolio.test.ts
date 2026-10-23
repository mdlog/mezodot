import { describe, expect, it } from 'vitest';
import { valuePosition } from '@mezodot/sdk';
import { E18, SHARE, position, prices, protocol } from '../test/fixtures';
import { accountHoldings } from './portfolio';

const valued = valuePosition(protocol, position, prices);
// 10 pMUSD (11 MUSD) still in the wallet; MUSD and BTC there are not supplied and count for nothing here.
const wallet = { MUSD: 50n * E18, pMUSD: 10n * SHARE, pMEZO: 0n, BTC: E18 };

describe('account holdings', () => {
  it('values pTokens in the wallet and posted at the pool exchange rate, and counts posted shares once in net worth', () => {
    const p = accountHoldings(protocol, valued, wallet, prices);
    expect(p.supplies).toHaveLength(1);
    expect(p.supplies[0].market.symbol).toBe('MUSD');
    expect(p.supplies[0].walletUnits).toBeCloseTo(11, 9);
    expect(p.supplies[0].postedUnits).toBeCloseTo(110, 9);
    expect(p.supplies[0].valueUsd).toBeCloseTo(121, 9);
    expect(p.suppliedUsd).toBeCloseTo(121, 9);
    // 11 in the wallet + 2,210 of collateral (the posted 110 among it) − 500 of debt.
    expect(p.netWorthUsd).toBeCloseTo(1_721, 9);
  });

  it('leaves supply and net worth unknown, never zero, while the wallet cannot be read', () => {
    const p = accountHoldings(protocol, valued, undefined, prices);
    expect(p.suppliedUsd).toBeNull();
    expect(p.netWorthUsd).toBeNull();
    expect(p.supplies).toHaveLength(1);
    expect(p.supplies[0].walletUnits).toBeUndefined();
    expect(p.supplies[0].postedUnits).toBeCloseTo(110, 9);
    expect(p.supplies[0].valueUsd).toBeUndefined();
  });

  it('lists a pool once its pTokens are only in the wallet, at that pool price', () => {
    const p = accountHoldings(protocol, valued, { ...wallet, pMEZO: 1_000n * SHARE }, prices);
    expect(p.supplies.map((s) => s.market.symbol)).toEqual(['MUSD', 'MEZO']);
    // 1 pMEZO = 1 MEZO at $0.30.
    expect(p.supplies[1].walletUnits).toBeCloseTo(1_000, 9);
    expect(p.supplies[1].postedUnits).toBe(0);
    expect(p.supplies[1].valueUsd).toBeCloseTo(300, 9);
    expect(p.netWorthUsd).toBeCloseTo(2_021, 9);
  });
});
