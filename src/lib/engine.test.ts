import { describe, expect, it } from 'vitest';
import { PRICES } from '../data/mock';
import {
  accrueInterest,
  borrow,
  closeLoop,
  createInitialState,
  marketStats,
  openLoop,
  postCollateral,
  protocolKpis,
  repay,
  summarize,
  supply,
  withdraw,
  type ActionResult,
  type DemoState,
} from './engine';

const expectOk = (r: ActionResult): DemoState => {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.state;
};
const expectError = (r: ActionResult): string => {
  if (r.ok) throw new Error('expected an error');
  return r.error;
};

describe('initial scenario', () => {
  const s = createInitialState(0);
  const sum = summarize(s);

  it('values the LP deposit at exactly 10,000 MUSD', () => {
    expect(sum.earn.MUSD).toBeCloseTo(10_000, 8);
  });

  it('matches the Arbitrum wETH borrower position', () => {
    expect(sum.collateral).toBe(7_680);
    expect(sum.healthFactor).toBeCloseTo(1.969, 3);
    expect(sum.available).toBeCloseTo(2_256, 6);
  });

  it('exposes derived protocol KPIs', () => {
    expect(protocolKpis().tvl).toBe(46_100_000);
    expect(marketStats('MUSD').liquidity).toBe(9_594_000);
  });
});

describe('supply / withdraw', () => {
  it('values MEZO activity in USD, not token count', () => {
    const s = expectOk(supply(createInitialState(0), 'MEZO', 100));
    expect(s.activities[0].value).toBe(100 * PRICES.MEZO);
  });

  it('round-trips a MAX withdrawal without leftover dust', () => {
    const s0 = createInitialState(0);
    const max = summarize(s0).earn.MUSD;
    const s1 = expectOk(withdraw(s0, 'MUSD', max));
    expect(s1.account.earnShares.pMUSD).toBe(0);
    expect(s1.account.wallet.MUSD).toBeCloseTo(s0.account.wallet.MUSD + 10_000, 6);
  });

  it('rejects over-withdrawal', () => {
    expect(expectError(withdraw(createInitialState(0), 'MEZO', 1))).toMatch(/exceeds/);
  });
});

describe('borrow / repay', () => {
  it('reports the post-borrow health factor', () => {
    const s = expectOk(borrow(createInitialState(0), 1_000));
    expect(s.activities[0].detail).toMatch(/1\.97× → 1\.49×/);
  });

  it('rejects borrowing above capacity', () => {
    expect(expectError(borrow(createInitialState(0), 3_000))).toMatch(/capacity/);
  });

  it('logs repayments as Repay and shows no health factor once debt is cleared', () => {
    const s = expectOk(repay(createInitialState(0), 3_120));
    expect(s.activities[0].kind).toBe('Repay');
    expect(summarize(s).healthFactor).toBe(Infinity);
  });
});

describe('cross-chain collateral', () => {
  it('debits the spoke wallet so the same funds cannot be posted twice', () => {
    const s1 = expectOk(postCollateral(createInitialState(0), 'arbitrum', 'wETH', 1.82));
    expect(s1.account.spokeWallet.arbitrum.wETH).toBe(0);
    expect(s1.account.collateral.arbitrum.wETH).toBeCloseTo(4.22, 8);
    expect(expectError(postCollateral(s1, 'arbitrum', 'wETH', 0.1))).toMatch(/exceeds/);
  });

  it('tracks collateral per chain', () => {
    const s = expectOk(postCollateral(createInitialState(0), 'ethereum', 'USDC', 1_000));
    const eth = summarize(s).remoteByChain.find((c) => c.chain.id === 'ethereum')!;
    expect(eth.usd).toBe(1_000);
    expect(s.activities[0].source).toBe('Ethereum Spoke');
  });
});

describe('loop', () => {
  it('folds the loop into the global health factor', () => {
    const s = expectOk(openLoop(createInitialState(0), 1_000, 3));
    const sum = summarize(s);
    expect(sum.loopCollateral).toBeCloseTo(3_000, 6);
    expect(sum.debt).toBeCloseTo(5_120, 6);
    expect(sum.healthFactor).toBeCloseTo((10_680 * 0.8) / 5_120, 6);
    expect(sum.loopEquity).toBeCloseTo(1_000, 6);
  });

  it('rejects leverage beyond the max LTV', () => {
    expect(expectError(openLoop(createInitialState(0), 1_000, 4))).toMatch(/max LTV/);
  });

  it('unwinds and returns equity', () => {
    const s0 = createInitialState(0);
    const s1 = expectOk(openLoop(s0, 1_000, 3));
    const s2 = expectOk(closeLoop(s1));
    expect(s2.account.loop.shares).toBe(0);
    expect(s2.account.wallet.MUSD).toBeCloseTo(s0.account.wallet.MUSD, 6);
  });

  it('refuses to unwind when Hub debt relies on loop collateral', () => {
    const s1 = expectOk(openLoop(createInitialState(0), 1_000, 2));
    const s2 = expectOk(borrow(s1, summarize(s1).available));
    expect(expectError(closeLoop(s2))).toMatch(/Repay/);
  });
});

describe('interest accrual', () => {
  it('grows pToken rates and debt, and pays MEZO rewards', () => {
    const s0 = createInitialState(0);
    const s1 = expectOk(accrueInterest(s0, 30));
    expect(s1.rates.pMUSD).toBeGreaterThan(s0.rates.pMUSD);
    expect(s1.previousRates.pMUSD).toBe(s0.rates.pMUSD);
    expect(s1.account.debtMUSD).toBeGreaterThan(s0.account.debtMUSD);
    expect(s1.account.wallet.MEZO).toBeGreaterThan(s0.account.wallet.MEZO);
    expect(summarize(s1).earn.MUSD).toBeGreaterThan(10_000);
    expect(s1.elapsedDays).toBe(30);
  });

  it('makes a 3× loop net-positive only thanks to rewards', () => {
    const s1 = expectOk(openLoop(createInitialState(0), 1_000, 3));
    const s2 = expectOk(accrueInterest(s1, 365));
    const equityGain = summarize(s2).loopEquity - 1_000;
    // Rate growth minus debt growth on its own is negative (borrow APY > base supply APY).
    expect(equityGain).toBeLessThan(0);
    expect(s2.account.wallet.MEZO - s1.account.wallet.MEZO).toBeGreaterThan(0);
  });
});
