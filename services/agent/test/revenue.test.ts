import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRICE_KEYS, type ProtocolState } from '@mezodot/sdk';
import { RevenueTracker, buildRevenueReport } from '../src/revenue';

const E18 = 10n ** 18n;
const POOL_MUSD = '0x00000000000000000000000000000000000000A1';
const TREASURY = '0x000000000000000000000000000000000000c0de';

const protocol = {
  markets: [
    {
      id: 0,
      symbol: 'MUSD',
      pool: POOL_MUSD,
      decimals: 18,
      shareDecimals: 24,
      priceKey: PRICE_KEYS.MUSD,
      exchangeRate: (E18 * 102n) / 100n, // 1 pMUSD share-unit = 1.02 MUSD
      totalReserves: 125n * 10n ** 17n,
      reserveFactor: 10n ** 17n,
    },
  ],
  collaterals: [
    { id: 0, symbol: 'pMUSD', isShare: true, isRemote: false, token: POOL_MUSD.toLowerCase(), decimals: 18, priceKey: PRICE_KEYS.MUSD },
    { id: 1, symbol: 'BTC', isShare: false, isRemote: false, token: '0x7b7C000000000000000000000000000000000000', decimals: 18, priceKey: PRICE_KEYS.BTC },
  ],
  blockNumber: 123n,
  treasury: TREASURY,
  liquidationFeeBps: 1_000,
} as unknown as ProtocolState;

describe('protocol revenue (revenue-visibility)', () => {
  it('reports reserves, flash fees, withdrawals, bad debt and the treasury share of liquidation bonuses', () => {
    const r = buildRevenueReport(
      protocol,
      {
        cursor: 1_001n,
        flashFees: { [POOL_MUSD.toLowerCase()]: 9n * 10n ** 17n },
        reservesWithdrawn: { [POOL_MUSD.toLowerCase()]: 2n * E18 },
        badDebtFromReserves: { [POOL_MUSD.toLowerCase()]: E18 / 2n },
        liquidationFees: { '1': 5n * 10n ** 14n, '0': 10n ** 24n },
      },
      [
        { id: 0, balance: 10n ** 24n }, // one whole pMUSD share unit (24 decimals) = 1.02 MUSD
        { id: 1, balance: 5n * 10n ** 14n },
      ],
      { MUSD: 0.99, BTC: 80_000 },
    );
    expect(r).toMatchObject({ treasury: TREASURY, liquidationFeeBps: 1_000, blockNumber: '123', scannedTo: '1000', scanError: null });
    expect(r.markets).toEqual([
      {
        market: 'MUSD',
        pool: POOL_MUSD,
        reserveFactor: 0.1,
        totalReserves: '12.5',
        totalReservesUsd: 12.5 * 0.99,
        flashFees: '0.9',
        reservesWithdrawn: '2',
        badDebtFromReserves: '0.5',
      },
    ]);
    expect(r.liquidationFees).toEqual([
      { collateralId: 0, symbol: 'pMUSD', taken: '1', takenUsd: 1.02 * 0.99, treasuryBalance: '1', treasuryBalanceUsd: 1.02 * 0.99 },
      { collateralId: 1, symbol: 'BTC', taken: '0.0005', takenUsd: 40, treasuryBalance: '0.0005', treasuryBalanceUsd: 40 },
    ]);
    expect(r.totals.reservesUsd).toBeCloseTo(12.375, 9);
    expect(r.totals.treasuryCollateralUsd).toBeCloseTo(40 + 1.02 * 0.99, 9);
  });

  it('values without a price as null instead of $0, and starts over for another VaultManager', () => {
    const r = buildRevenueReport(protocol, { cursor: null, flashFees: {}, reservesWithdrawn: {}, liquidationFees: {} }, [], {});
    expect(r.markets[0].totalReservesUsd).toBeNull();
    expect(r.scannedTo).toBeNull();
    expect(r.totals).toEqual({ reservesUsd: 0, treasuryCollateralUsd: 0 });

    const dir = mkdtempSync(join(tmpdir(), 'mezodot-revenue-'));
    const ctxFor = (vaultManager: string) => ({
      config: { env: 'devnet', stateDir: dir },
      hub: { network: 'devnet-hub', client: {}, deployment: { startBlock: 0, contracts: { vaultManager } } },
      log: () => {},
    });
    const first = new RevenueTracker(ctxFor('0x0000000000000000000000000000000000000001') as never, {} as never);
    first.store.update((s) => {
      s.cursor = 500n;
      s.flashFees = { x: 1n };
    });
    const redeployed = new RevenueTracker(ctxFor('0x0000000000000000000000000000000000000002') as never, {} as never);
    expect(redeployed.store.get()).toMatchObject({ vaultManager: '0x0000000000000000000000000000000000000002', cursor: null, flashFees: {} });
  });
});
