import { describe, expect, it } from 'vitest';
import { INITIAL_ACCOUNT, INITIAL_RATES, LP_DEPOSIT, MARKETS, PRICES, PROTOCOL, RESERVE_FACTOR, RISK_METRICS, RISK_PARAMS } from '../data/mock';
import {
  accrue,
  availableLiquidity,
  borrowCapacity,
  emission,
  healthFactor,
  healthStatus,
  liquidationPrice,
  loanToValue,
  maxLeverage,
  parseAmount,
  planLoop,
  sharesForAssets,
  supplyApy,
  utilization,
} from './protocol';

const [musd, mezo] = MARKETS;
const musdSupplyApy = supplyApy(musd.borrowApy, utilization(musd.supplied, musd.borrowed), RESERVE_FACTOR);
const loopParams = {
  supplyApyPct: musdSupplyApy + musd.rewardApr,
  borrowApyPct: musd.borrowApy,
  maxLtv: RISK_PARAMS.maxLtv,
  liquidationThreshold: RISK_PARAMS.liquidationThreshold,
};

describe('market economics', () => {
  it('derives utilization from pool sizes', () => {
    expect(utilization(musd.supplied, musd.borrowed)).toBeCloseTo(0.61, 4);
    expect(utilization(mezo.supplied, mezo.borrowed)).toBeCloseTo(0.44, 4);
    expect(utilization(0, 10)).toBe(0);
  });

  it('never pays suppliers more base interest than borrowers pay', () => {
    for (const m of MARKETS) {
      const util = utilization(m.supplied, m.borrowed);
      const apy = supplyApy(m.borrowApy, util, RESERVE_FACTOR);
      expect(apy * m.supplied).toBeLessThanOrEqual(m.borrowApy * m.borrowed);
      expect(apy).toBeLessThan(m.borrowApy);
    }
    expect(musdSupplyApy).toBeCloseTo(2.85, 2);
  });

  it('reports available liquidity as supplied minus borrowed', () => {
    expect(availableLiquidity(musd.supplied, musd.borrowed)).toBe(9_594_000);
    expect(availableLiquidity(10, 20)).toBe(0);
  });

  it('keeps pToken exchange rates consistent with pool assets/shares', () => {
    expect(sharesForAssets(LP_DEPOSIT, INITIAL_RATES.pMUSD)).toBeCloseTo(9_803.0, 1);
  });

  it('keeps protocol-level KPIs coherent', () => {
    const tvl = musd.supplied * PRICES.MUSD + mezo.supplied * PRICES.MEZO + PROTOCOL.remoteCollateralUsd;
    expect(tvl).toBe(46_100_000);
    // Remote-backed borrowing must itself respect the max LTV.
    expect(PROTOCOL.remoteBackedBorrow / PROTOCOL.remoteCollateralUsd).toBeLessThanOrEqual(RISK_PARAMS.maxLtv);
    expect(PROTOCOL.remoteBackedBorrow / musd.borrowed).toBeCloseTo(0.26, 2);
    expect(RISK_METRICS.dsr).toBeGreaterThan(RISK_METRICS.dsrThreshold);
  });
});

describe('position risk', () => {
  const collateral = INITIAL_ACCOUNT.collateral.arbitrum.wETH * PRICES.wETH;

  it('computes the initial Arbitrum wETH borrower position', () => {
    expect(collateral).toBe(7_680);
    expect(loanToValue(collateral, INITIAL_ACCOUNT.debtMUSD)).toBeCloseTo(0.40625, 5);
    expect(healthFactor(collateral, INITIAL_ACCOUNT.debtMUSD, RISK_PARAMS.liquidationThreshold)).toBeCloseTo(1.969, 3);
    expect(borrowCapacity(collateral, INITIAL_ACCOUNT.debtMUSD, RISK_PARAMS.maxLtv)).toBeCloseTo(2_256, 6);
  });

  it('returns Infinity health factor when there is no debt', () => {
    expect(healthFactor(1_000, 0, 0.8)).toBe(Infinity);
    expect(healthStatus(Infinity).label).toBe('Healthy');
  });

  it('never returns negative borrow capacity', () => {
    expect(borrowCapacity(1_000, 900, 0.7)).toBe(0);
  });

  it('computes the wETH liquidation price including stable collateral', () => {
    expect(liquidationPrice(2.4, 0, 3_120, 0.8)).toBeCloseTo(1_625, 6);
    expect(liquidationPrice(2.4, 5_000, 3_120, 0.8)).toBe(0);
    expect(liquidationPrice(0, 0, 3_120, 0.8)).toBeNull();
    expect(liquidationPrice(2.4, 0, 0, 0.8)).toBeNull();
  });

  it('uses one set of health thresholds', () => {
    expect(healthStatus(1.97).label).toBe('Healthy');
    expect(healthStatus(1.3).label).toBe('Monitor');
    expect(healthStatus(1.1).label).toBe('At risk');
  });
});

describe('leverage loop', () => {
  it('caps leverage at 1 / (1 − maxLtv)', () => {
    expect(maxLeverage(0.7)).toBeCloseTo(3.333, 3);
  });

  it('reproduces the PRD scenario: 1,000 MUSD at 3×', () => {
    const plan = planLoop(1_000, 3, loopParams);
    expect(plan.error).toBeNull();
    expect(plan.gross).toBe(3_000);
    expect(plan.debt).toBe(2_000);
    expect(plan.ltv).toBeCloseTo(0.6667, 4);
    expect(plan.healthFactor).toBeCloseTo(1.2, 6);
    expect(plan.liquidationBuffer).toBeCloseTo(16.67, 2);
    // 3 × (2.8548 + 4.5) − 2 × 5.2
    expect(plan.netApy).toBeCloseTo(11.66, 2);
  });

  it('rejects leverage above the max LTV', () => {
    expect(planLoop(1_000, 3.5, loopParams).error).toMatch(/max LTV/);
    expect(planLoop(1_000, 4, loopParams).error).toMatch(/max LTV/);
  });

  it('rejects invalid principal', () => {
    expect(planLoop(0, 3, loopParams).error).toMatch(/valid/);
    expect(planLoop(Number.NaN, 3, loopParams).error).toMatch(/valid/);
  });

  it('is unprofitable without rewards because borrow > base supply', () => {
    const plan = planLoop(1_000, 3, { ...loopParams, supplyApyPct: musdSupplyApy });
    expect(plan.netApy).toBeLessThan(musdSupplyApy);
  });
});

describe('accrual and parsing', () => {
  it('compounds over a full year to the APY', () => {
    expect(accrue(100, 5, 365)).toBeCloseTo(105, 8);
    expect(accrue(100, 5, 0)).toBe(100);
  });

  it('emits rewards linearly', () => {
    expect(emission(10_000, 4.5, 365)).toBeCloseTo(450, 8);
  });

  it('parses only positive finite amounts', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('  ')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-3')).toBeNull();
    expect(parseAmount('12.5')).toBe(12.5);
  });
});
