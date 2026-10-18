import { describe, expect, it, vi } from 'vitest';
import { maxUint256, zeroAddress, type PublicClient } from 'viem';
import { toBytes32, type CollateralState, type MarketState } from '@mezodot/sdk';
import { HUB, SPOKES } from '../chain/env';
import {
  borrowBlocked,
  borrowRoom,
  collateralRoom,
  lockBlocked,
  lockRoom,
  postBlocked,
  readHubFlags,
  readSpokeLockState,
  repayWithSharesPlan,
  INCLUSION_SECONDS,
  pendingInterest,
  supplyBlocked,
  supplyRoom,
  type HubFlags,
  type SpokeLockState,
} from './guards';

const market = (patch: Partial<MarketState> = {}) =>
  ({ id: 0, symbol: 'MUSD', supplyCap: maxUint256, borrowCap: maxUint256, totalAssets: 100n, totalBorrows: 40n, ...patch }) as MarketState;
const flags = (patch: Partial<HubFlags> = {}, market0: Partial<HubFlags['markets'][number]> = {}): HubFlags => ({
  vaultPaused: false,
  markets: { 0: { poolPaused: false, enabled: true, ...market0 } },
  ...patch,
});

describe('caps', () => {
  it('leave room up to the cap, unlimited when uncapped', () => {
    expect(supplyRoom(market())).toBe(maxUint256);
    expect(supplyRoom(market({ supplyCap: 150n }))).toBe(50n);
    expect(supplyRoom(market({ supplyCap: 90n }))).toBe(0n);
    expect(borrowRoom(market({ borrowCap: 50n }))).toBe(10n);
    expect(collateralRoom({ cap: 10n, total: 12n })).toBe(0n);
    expect(lockRoom({ cap: 10n, locked: 4n })).toBe(6n);
  });
});

describe('caps leave room for interest accrued before the transaction lands', () => {
  // 1,000,000 MUSD borrowed at 10%/yr ≈ 3.17e-9 per second (WAD).
  const rate = 3_170_979_198n;
  const borrows = 1_000_000n * 10n ** 18n;
  const now = 1_800_000_000n;

  it('holds back borrow interest since the last accrual plus the inclusion window', () => {
    const m = { borrowCap: borrows + 1_000n * 10n ** 18n, totalBorrows: borrows, borrowRatePerSecond: rate, accrualTimestamp: now - 3_600n };
    const pending = pendingInterest(m, m.accrualTimestamp, now);
    // An hour since the pool accrued plus INCLUSION_SECONDS of interest on 1M at 10%.
    expect(pending).toBe((borrows * rate * (3_600n + INCLUSION_SECONDS)) / 10n ** 18n);
    expect(pending).toBeGreaterThan(11n * 10n ** 18n);
    const roomNow = borrowRoom({ ...m, accrualTimestamp: now - 3_600n });
    expect(roomNow).toBeLessThan(1_000n * 10n ** 18n);
  });

  it('holds back only the inclusion window on supply (totalAssets already includes pending interest)', () => {
    const m = { supplyCap: 2_000_000n * 10n ** 18n, totalAssets: 1_500_000n * 10n ** 18n, totalBorrows: borrows, borrowRatePerSecond: rate };
    expect(supplyRoom(m)).toBe(m.supplyCap - m.totalAssets - (borrows * rate * INCLUSION_SECONDS) / 10n ** 18n);
  });

  it('changes nothing without a rate or when uncapped', () => {
    expect(pendingInterest({ totalBorrows: borrows }, now - 100n, now)).toBe(0n);
    expect(borrowRoom({ borrowCap: maxUint256, totalBorrows: borrows, borrowRatePerSecond: rate })).toBe(maxUint256);
  });
});

describe('hub switches', () => {
  it('block supply only for a paused pool or a full one', () => {
    expect(supplyBlocked(market(), flags())).toBeNull();
    expect(supplyBlocked(market(), undefined)).toBeNull(); // unknown flags never block: the contract still decides
    expect(supplyBlocked(market(), flags({}, { poolPaused: true }))).toMatch(/MUSD pool is paused: new supply is blocked. Withdrawals still work/);
    expect(supplyBlocked(market({ supplyCap: 100n }), flags())).toMatch(/supply cap/);
    // VaultManager's pause is about borrowing: supply stays open.
    expect(supplyBlocked(market(), flags({ vaultPaused: true }))).toBeNull();
  });

  it('block borrows for either pause, a disabled market or the borrow cap', () => {
    expect(borrowBlocked(market(), flags())).toBeNull();
    expect(borrowBlocked(market(), flags({ vaultPaused: true }))).toMatch(/^Borrowing is paused/);
    expect(borrowBlocked(market(), flags({}, { poolPaused: true }))).toMatch(/pool is paused: new borrows are blocked/);
    expect(borrowBlocked(market(), flags({}, { enabled: false }))).toMatch(/switched off/);
    expect(borrowBlocked(market({ borrowCap: 40n }), flags())).toMatch(/borrow cap/);
  });

  it('block new collateral that is disabled or at its cap', () => {
    const c = { symbol: 'BTC', enabled: true, cap: 10n, total: 1n } as CollateralState;
    expect(postBlocked(c)).toBeNull();
    expect(postBlocked({ ...c, enabled: false })).toMatch(/not accepted as new collateral/);
    expect(postBlocked({ ...c, total: 10n })).toMatch(/reached its cap/);
  });

  it('repaying with posted shares repays what they cover, and refuses to leave debt with no collateral', () => {
    // 1 pMUSD (24 decimals) = 1.1 MUSD (18 decimals).
    const m = { id: 0, symbol: 'MUSD', shareDecimals: 24, exchangeRate: 11n * 10n ** 17n };
    const share = { id: 0, symbol: 'pMUSD' };
    const pos = (shares: bigint, debt: bigint, extra: { collateral?: bigint; otherDebt?: bigint } = {}) => ({
      collateral: [
        { id: 0, balance: shares, valueUsd: 0n },
        { id: 1, balance: extra.collateral ?? 0n, valueUsd: 0n },
      ],
      debts: [
        { marketId: 0, amount: debt },
        { marketId: 1, amount: extra.otherDebt ?? 0n },
      ],
    });
    const ONE = 10n ** 24n;
    const MUSD = 10n ** 18n;
    // Covers the whole debt: only part of the shares burn.
    expect(repayWithSharesPlan(m, share, pos(10n * ONE, 5n * MUSD))).toEqual({ repaid: 5n * MUSD, burnsAll: false, blocked: null });
    // Covers part of it while other collateral stays behind: fine.
    expect(repayWithSharesPlan(m, share, pos(ONE, 5n * MUSD, { collateral: 1n }))).toEqual({ repaid: (11n * MUSD) / 10n, burnsAll: true, blocked: null });
    // Covers part of it and is the only collateral: VaultManager reverts (WouldLeaveBadDebt).
    expect(repayWithSharesPlan(m, share, pos(ONE, 5n * MUSD)).blocked).toMatch(/only collateral and does not cover all your debt/);
    // Covers this debt exactly, but another market still owes with nothing posted: also refused.
    expect(repayWithSharesPlan(m, share, pos(ONE, (11n * MUSD) / 10n, { otherDebt: 1n })).blocked).toMatch(/only collateral/);
    expect(repayWithSharesPlan(m, share, pos(ONE, 0n)).blocked).toMatch(/No MUSD debt/);
    expect(repayWithSharesPlan(m, share, pos(0n, MUSD)).blocked).toMatch(/No pMUSD posted/);
  });

  it('are read from VaultManager and every pool', async () => {
    const readContract = vi.fn(async ({ functionName, address }: { functionName: string; address: string }) =>
      functionName === 'markets' ? { enabled: address !== '0x0' } : functionName === 'paused' && address === '0xpool1',
    );
    const result = await readHubFlags({ readContract } as unknown as PublicClient, '0xvm' as never, [
      { id: 0, pool: '0xpool0' as never },
      { id: 1, pool: '0xpool1' as never },
    ]);
    expect(result).toEqual({ vaultPaused: false, markets: { 0: { poolPaused: false, enabled: true }, 1: { poolPaused: true, enabled: true } } });
  });
});

describe('spoke locks', () => {
  const spoke = SPOKES.find((s) => s.deployment)!;
  const gateway = spoke.deployment!.contracts.spokeGateway;
  const ok: SpokeLockState = { paused: false, allowed: true, cap: 100n, locked: 10n, targetsHub: true, hubTrustsGateway: true, hubListsToken: true };

  it('go ahead only when the gateway is open and the hub will credit the message', () => {
    expect(lockBlocked(ok, 'Base Sepolia', 'WETH', 90n)).toBeNull();
    expect(lockBlocked({ ...ok, paused: true }, 'Base Sepolia', 'WETH')).toMatch(/gateway is paused/);
    expect(lockBlocked({ ...ok, allowed: false }, 'Base Sepolia', 'WETH')).toMatch(/WETH is not accepted/);
    expect(lockBlocked({ ...ok, hubTrustsGateway: false }, 'Base Sepolia', 'WETH')).toMatch(/could strand the tokens/);
    expect(lockBlocked({ ...ok, locked: 100n }, 'Base Sepolia', 'WETH')).toMatch(/reached its WETH cap/);
    expect(lockBlocked(ok, 'Base Sepolia', 'WETH', 91n)).toMatch(/still accepts under its cap/);
  });

  it('check both ends: the gateway’s hub emitter and the hub’s registration of gateway and token', async () => {
    const answers: Record<string, unknown> = {
      paused: false,
      tokens: [true, 100n],
      locked: 5n,
      hubEmitter: toBytes32(HUB.deployment!.contracts.wormholeAdapter),
      spokeEmitter: toBytes32(gateway),
      remoteCollateralId: 3n,
    };
    const client = { readContract: vi.fn(async ({ functionName }: { functionName: string }) => answers[functionName]) } as unknown as PublicClient;
    expect(await readSpokeLockState(spoke, client, client, spoke.deployment!.tokens.WETH)).toEqual({ ...ok, locked: 5n });
    answers.spokeEmitter = toBytes32(zeroAddress);
    answers.remoteCollateralId = 0n;
    answers.hubEmitter = `0x${'ff'.repeat(32)}`;
    expect(await readSpokeLockState(spoke, client, client, spoke.deployment!.tokens.WETH)).toMatchObject({
      targetsHub: false,
      hubTrustsGateway: false,
      hubListsToken: false,
    });
  });
});
