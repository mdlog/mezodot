import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex, PublicClient } from 'viem';
import type { MarketState, ProtocolState } from '@mezodot/sdk';
import { closeRow, hubActivity, unwindRow } from './activity';

const E18 = 10n ** 18n;
/** pMUSD shares carry 6 more decimals than MUSD (PToken._decimalsOffset). */
const SHARE = 10n ** 24n;
const MUSD = { symbol: 'MUSD', decimals: 18, receiptSymbol: 'pMUSD', shareDecimals: 24 };
const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1';
const TX: Hex = `0x${'ab'.repeat(32)}`;

describe('unwind rows name everything the unwind returned (final review WEB-7)', () => {
  it('shows the pMUSD returned when the pool had no idle cash to pay out', () => {
    // LeverageManager netted 2,001.80 MUSD of debt, then returned all 998.20 of equity as pMUSD: nothing was paid out.
    const row = unwindRow({ repaid: 20_018n * (E18 / 10n), shares: 998n * SHARE, out: 0n, sharesReturned: 998n * SHARE }, MUSD);
    expect(row).toEqual({
      asset: 'pMUSD',
      amount: 998n * SHARE,
      decimals: 24,
      detail: "Repaid 2,001.80 MUSD with pMUSD · equity returned as pMUSD (the pool's idle cash was short)",
    });
  });

  it('adds the pMUSD returned to the MUSD paid out when idle cash covered part of it', () => {
    const row = unwindRow({ repaid: 2_000n * E18, shares: 800n * SHARE, out: 500n * E18, sharesReturned: 300n * SHARE }, MUSD);
    expect(row).toMatchObject({ asset: 'MUSD', amount: 500n * E18, decimals: 18 });
    expect(row.detail).toBe("Repaid 2,000.00 MUSD with pMUSD · 300.00 pMUSD returned on top (the pool's idle cash was short)");
    expect(unwindRow({ repaid: 2_000n * E18, shares: 998n * SHARE, out: 998n * E18, sharesReturned: 0n }, MUSD).detail).toBe(
      'Repaid 2,000.00 MUSD with pMUSD · equity paid out',
    );
    // A withdraw-only unwind (no debt left to net).
    expect(unwindRow({ repaid: 0n, shares: 10n * SHARE, out: 10n * E18, sharesReturned: 0n }, MUSD).detail).toBe('Equity paid out');
  });

  it('shows the debt repaid when the unwind only netted it and withdrew nothing', () => {
    // Other debt kept every remaining pMUSD posted (planUnwind withdrew nothing): the event carries out = shares = 0.
    expect(unwindRow({ repaid: 1_500n * E18, shares: 0n, out: 0n, sharesReturned: 0n }, MUSD)).toEqual({
      asset: 'MUSD',
      amount: 1_500n * E18,
      decimals: 18,
      detail: 'Debt repaid with posted pMUSD · nothing withdrawn',
    });
  });

  it('includes the MUSD a BTC close returned beyond the debt', () => {
    const row = closeRow({ repaid: 1_000n * E18, sold: 12n * (E18 / 1_000n), collateralOut: 8n * (E18 / 1_000n), debtAssetOut: 1_234n * (E18 / 100n) });
    expect(row).toEqual({
      asset: 'BTC',
      amount: 8n * (E18 / 1_000n),
      decimals: 18,
      detail: 'BTC leverage closed · repaid 1,000.00 MUSD, sold 0.012000 BTC · 12.34 MUSD returned',
    });
    expect(closeRow({ repaid: E18, sold: 1n, collateralOut: 1n, debtAssetOut: 0n }).detail).not.toMatch(/returned/);
  });

  it('builds the history rows from the events', async () => {
    const events: Record<string, unknown[]> = {
      Unwound: [
        {
          args: { account: ACCOUNT, repaid: 2_000n * E18, shares: 900n * SHARE, out: 0n, sharesReturned: 900n * SHARE },
          transactionHash: TX,
          blockNumber: 5n,
          logIndex: 1,
        },
      ],
      Closed: [
        {
          args: { account: ACCOUNT, repaid: 100n * E18, withdrawn: E18, sold: E18 / 100n, collateralOut: (E18 * 99n) / 100n, debtAssetOut: 2n * E18 },
          transactionHash: TX,
          blockNumber: 5n,
          logIndex: 2,
        },
      ],
    };
    const client = {
      getContractEvents: vi.fn(async ({ eventName }: { eventName: string }) => events[eventName] ?? []),
      getBlock: vi.fn(async () => ({ timestamp: 1_800_000_000n })),
    } as unknown as PublicClient;
    const protocol = { markets: [{ id: 0, ...MUSD } as MarketState], collaterals: [] } as unknown as ProtocolState;
    const rows = await hubActivity(client, protocol, ACCOUNT, { fromBlock: 0n, toBlock: 10n });
    expect(rows.map((r) => [r.kind, r.asset, r.amount, r.detail])).toEqual([
      ['Unwind', 'pMUSD', 900n * SHARE, "Repaid 2,000.00 MUSD with pMUSD · equity returned as pMUSD (the pool's idle cash was short)"],
      ['Unwind', 'BTC', (E18 * 99n) / 100n, 'BTC leverage closed · repaid 100.00 MUSD, sold 0.010000 BTC · 2.00 MUSD returned'],
    ]);
  });
});
