import { describe, expect, it } from 'vitest';
import { agentState } from '../components/Topology';
import { agentBadge, watchRow, type Evaluation } from './Agents';

const account = (patch: Partial<Evaluation> = {}): Evaluation => ({
  account: '0x00000000000000000000000000000000000000a1',
  healthFactor: 0.95,
  debtUsd: 500,
  ...patch,
});
const assessment = (patch: Partial<NonNullable<Evaluation['assessment']>> = {}): NonNullable<Evaluation['assessment']> => ({
  action: 'liquidate',
  sale: 'sell',
  netProfitUsd: 12.34,
  reason: 'profitable after selling the seized BTC on Tigris',
  ...patch,
});

describe('liquidation watchlist', () => {
  it('shows the profit the keeper can realise, net of gas, fees and the sale', () => {
    expect(watchRow(account({ assessment: assessment() }))).toEqual({
      state: 'LIQ',
      note: 'net +$12.34',
      reason: 'profitable after selling the seized BTC on Tigris',
    });
    expect(watchRow(account({ assessment: assessment({ action: 'skip', sale: null, netProfitUsd: -0.4, reason: 'below MIN_PROFIT_USD' }) }))).toEqual({
      state: 'SKIP',
      note: 'net −$0.40',
      reason: 'below MIN_PROFIT_USD',
    });
    expect(watchRow(account({ assessment: assessment({ sale: 'hold', netProfitUsd: 2_400 }) }))).toMatchObject({
      state: 'LIQ',
      note: 'net +$2.4K, seizure held',
    });
  });

  it('marks unpriced liquidatable accounts without inventing a profit, and only watches the rest', () => {
    const unpriced = watchRow(account({ assessment: null }));
    expect(unpriced).toMatchObject({ state: '—', note: 'not priced by the keeper' });
    expect(unpriced.note).not.toMatch(/\$/);
    expect(watchRow(account({ healthFactor: 1.1 }))).toEqual({ state: 'WATCH', note: null, reason: null });
  });
});

describe('keeper badge', () => {
  it('follows the agent status, not only whether it answers', () => {
    expect(agentBadge(agentState(undefined), null)).toBe('CHECKING AGENT…');
    expect(agentBadge(agentState(null), null)).toBe('AGENT OFFLINE');
    expect(agentBadge(agentState({ ok: false, status: 'degraded', keeper: '0xkeeper' }), '0xkeeper')).toBe('AGENT DEGRADED');
    expect(agentBadge(agentState({ ok: true, status: 'ok' }), '0xkeeper')).toBe('AGENT KEEPER ACTIVE');
    expect(agentBadge(agentState({ ok: true, status: 'ok' }), null)).toBe('AGENT READ-ONLY');
  });
});
