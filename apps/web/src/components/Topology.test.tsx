import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QK } from '../data/hooks';
import { JOURNEYS, Topology, agentState, type AgentCheck, type AgentStatus } from './Topology';

const check = (name: string, ok: boolean, severity: AgentCheck['severity'] = 'critical'): AgentCheck => ({ name, ok, severity, detail: `${name} detail` });
const status = (patch: Partial<AgentStatus> = {}): AgentStatus => ({ ok: true, status: 'ok', modules: ['relayer'], keeper: null, checks: [], ...patch });

/** Server-renders the map with `/status` already answered (undefined: not asked yet). */
const render = (answer?: AgentStatus | null) => {
  // No garbage-collection timers: nothing may outlive the test.
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  if (answer !== undefined) client.setQueryData(QK.agent('/status'), answer);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Topology />
    </QueryClientProvider>,
  );
};

describe('agent status', () => {
  it('is checking before the first answer and offline when the agent does not answer', () => {
    expect(agentState(undefined)).toEqual({ state: 'checking', failing: [] });
    expect(agentState(null)).toEqual({ state: 'offline', failing: [] });
  });

  it('reads a degraded agent as degraded, naming the failing checks critical first', () => {
    const answer = status({
      ok: false,
      status: 'degraded',
      checks: [check('relayer:sequences', false, 'warning'), check('loop:relayer', true), check('oracle', false)],
    });
    const agent = agentState(answer);
    expect(agent.state).toBe('degraded');
    expect(agent.failing.map((c) => c.name)).toEqual(['oracle', 'relayer:sequences']);
  });

  it('stays ok with failing warnings only, and tolerates a body without checks', () => {
    expect(agentState(status({ checks: [check('tx:mezo-testnet', false, 'warning')] }))).toMatchObject({ state: 'ok', failing: [{ name: 'tx:mezo-testnet' }] });
    expect(agentState({ ok: true, status: 'ok' })).toEqual({ state: 'ok', failing: [] });
  });

  it('shows the state on the map instead of calling a degraded agent offline', () => {
    expect(render()).toContain('>checking</text>');
    expect(render(null)).toContain('>offline</text>');
    expect(render(status())).toContain('>online</text>');
    const degraded = render(status({ ok: false, status: 'degraded', checks: [check('gas:mezo-testnet', false)] }));
    expect(degraded).toContain('>degraded</text>');
    expect(degraded).toContain('aria-label="agent degraded: gas:mezo-testnet"');
    expect(degraded).toContain('gas:mezo-testnet: gas:mezo-testnet detail');
  });
});

describe('journeys', () => {
  const journey = (id: string) => JOURNEYS.find((j) => j.id === id)!;

  it('opens BTC leverage with a Tigris flash swap paid by the borrow, without the MUSD flash loan', () => {
    const steps = journey('btc').steps;
    expect(steps.map((s) => s.edge)).toEqual(['walletHub', 'leverageTigris', 'leverageVault', 'vaultPools']);
    expect(steps[1].fn).toMatch(/pool\.swap\(.*hook/);
    expect(steps[3].fn).toContain('tigrisPool');
    for (const s of steps) {
      expect(s.fn).not.toMatch(/flashLoan|Router/);
      expect(s.text).not.toMatch(/0\.09%|flash-lends|repays the flash loan/);
    }
  });

  it('keeps the MUSD loop on the pool flash loan, with the fee from the SDK', () => {
    const flash = journey('loop').steps.find((s) => s.edge === 'leveragePools')!;
    expect(flash.fn).toBe('MezodotPool.flashLoan(...)');
    expect(flash.text).toContain('0.09% fee');
  });

  it('never hard-codes a guardian count', () => {
    const html = render();
    expect(html).not.toMatch(/13 of 19|19 guardians|13 sign/);
    expect(html).toContain('guardian quorum');
    expect(JOURNEYS.flatMap((j) => j.steps).some((s) => /\b1[39]\b/.test(s.text))).toBe(false);
    expect(html).toContain('swap · hook');
  });
});
