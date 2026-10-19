import { describe, expect, it } from 'vitest';
import { parseEther } from 'viem';
import { spokeGatewayAbi } from '@mezodot/sdk';
import { Monitor, loopCheck } from '../src/health';
import { Loops, type LoopStats } from '../src/loops';
import type { RelayMessage } from '../src/relayer';
import { StuckTransactionError, TxSender } from '../src/tx';
import { scriptedChain } from './chain';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('agent loops (health-monitoring)', () => {
  it('counts runs and failures, never overlaps a run, and stops cleanly', async () => {
    const logs: string[] = [];
    const loops = new Loops((_s, m) => logs.push(m));
    let release!: () => void;
    let runs = 0;
    loops.every(
      'slow',
      5,
      () =>
        new Promise<void>((resolve) => {
          runs++;
          release = resolve;
        }),
    );
    let attempt = 0;
    loops.every('flaky', 1_000, async () => {
      if (attempt++ === 0) throw new Error('HTTP request failed.\nURL: https://rpc.example/v2/KEY');
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(runs).toBe(1); // ticks while the first run is in flight are no-ops
    const flaky = loops.snapshot().find((l) => l.name === 'flaky')!;
    expect(flaky).toMatchObject({ runs: 1, failures: 1, consecutiveFailures: 1, lastError: 'HTTP request failed.' });
    expect(logs).toContain('tick failed');

    loops.stop();
    expect(await loops.idle(10)).toBe(false); // still waiting for the slow run
    release();
    expect(await loops.idle(100)).toBe(true);
    const slow = loops.snapshot().find((l) => l.name === 'slow')!;
    expect(slow.runningSince).toBeNull();
    expect(slow.lastSuccessAt).not.toBeNull();
  });

  const stats = (over: Partial<LoopStats>): LoopStats => ({
    name: 'liquidator',
    intervalMs: 12_000,
    critical: true,
    runs: 10,
    failures: 0,
    consecutiveFailures: 0,
    runningSince: null,
    lastSuccessAt: 0,
    lastFailureAt: null,
    lastError: null,
    lastDurationMs: 100,
    ...over,
  });

  it('calls a loop stale after three intervals (at least 2 min) without success, and hung after 10 in flight (at least 5 min)', () => {
    expect(loopCheck(stats({ lastSuccessAt: 0 }), 100_000, 0).ok).toBe(true);
    const stale = loopCheck(stats({ lastSuccessAt: 0, consecutiveFailures: 12, lastError: 'execution reverted' }), 121_000, 0);
    expect(stale).toMatchObject({ ok: false, severity: 'critical' });
    expect(stale.detail).toMatch(/no successful run for 121 s \(12 failures in a row; last error: execution reverted\)/);
    expect(loopCheck(stats({ lastSuccessAt: null }), 200_000, 0).detail).toMatch(/no successful run since start/);
    const hung = loopCheck(stats({ runningSince: 0, lastSuccessAt: 0 }), 301_000, 0);
    expect(hung).toMatchObject({ ok: false });
    expect(hung.detail).toMatch(/in flight for 301 s/);
    expect(loopCheck(stats({ critical: false, lastSuccessAt: 0 }), 10_000_000, 0).severity).toBe('warning');
  });
});

type Sender = {
  address: string;
  stuckSince: number | null;
  recent: string[];
  counts: Record<string, Record<string, number>>;
  lastError: string | null;
  revertRate: () => number | null;
  refreshStuck: () => Promise<void>;
};

const sender = (over: Partial<Sender> = {}): Sender => ({
  address: '0x00000000000000000000000000000000000000ee',
  stuckSince: null,
  recent: [],
  counts: {},
  lastError: null,
  revertRate: () => null,
  refreshStuck: async () => {},
  ...over,
});

const pendingMessage = (over: Partial<RelayMessage>): RelayMessage => ({
  id: '10004/0xab/1',
  direction: 'deposit',
  source: 'base-sepolia',
  target: 'mezo-testnet',
  emitterChain: 10004,
  emitter: '0x00000000000000000000000000000000000000ab',
  sequence: 1n,
  txHash: '0x01',
  blockNumber: 1n,
  status: 'waiting_vaa',
  attempts: 0,
  observedAt: 0,
  ...over,
});

/** Monitor over fake services: a keeper on the hub and one spoke, everything healthy unless overridden. */
function monitorWith(o: {
  now?: () => number;
  balances?: Record<string, bigint>;
  oracle?: { healthy?: boolean; stale?: boolean; report?: boolean };
  messages?: RelayMessage[];
  skipped?: Record<string, number>;
  hubSender?: Sender | TxSender;
  webhook?: string;
  fetch?: typeof fetch;
  events?: unknown[];
  failingScans?: { network: string; since: number; error: string }[];
}) {
  let t = 1_000_000;
  const now = o.now ?? (() => t);
  const logs: string[] = [];
  const loops = new Loops(() => {}, now);
  const report = {
    checkedAt: 1,
    healthy: o.oracle?.healthy ?? true,
    feeds: [{ symbol: 'USDC', status: o.oracle?.healthy === false ? 'unavailable' : 'ok', validForSec: 100 }],
  };
  const services = {
    ctx: {
      config: {
        env: 'testnet',
        modules: new Set(['relayer', 'liquidator', 'oracle', 'http']),
        oracleWatchMs: 30_000,
        pollMs: 6_000,
        minGasBalance: { 'mezo-testnet': parseEther('0.0001'), 'base-sepolia': parseEther('0.002') },
        alertWebhookUrl: o.webhook ?? null,
      },
      hub: {
        network: 'mezo-testnet',
        client: { getBalance: async () => o.balances?.['mezo-testnet'] ?? parseEther('1') },
        wallet: { account: { address: '0x00000000000000000000000000000000000000ee' } },
        sender: o.hubSender ?? sender(),
        deployment: { startBlock: 1, contracts: { vaultManager: '0x01', wormholeAdapter: '0x02', keeperGateway: '0x03' } },
      },
      spokes: [
        {
          network: 'base-sepolia',
          client: { getBalance: async () => o.balances?.['base-sepolia'] ?? parseEther('1') },
          sender: sender(),
          deployment: { startBlock: 2, contracts: { spokeGateway: '0x04' } },
        },
      ],
      log: (_s: string, m: string) => logs.push(m),
      fetch: o.fetch ?? fetch,
    },
    loops,
    relayer: {
      pending: () => o.messages ?? [],
      isStuck: (m: RelayMessage, at: number) => at - m.observedAt > 600_000,
      canDeliver: () => true,
      gaps: () => [],
      failingScans: () => o.failingScans ?? [],
      summary: () => ({ pending: 0, waitingVaa: 0, ready: 0, stuck: [], oldestPendingAgeSec: null, gaps: [] }),
    },
    liquidator: {
      lastTick: o.skipped ? { at: 0, evaluated: 3, liquidatable: 1, liquidated: 0, skipped: o.skipped } : null,
      syncError: null,
      lastInventory: { MUSD: '50.0' },
      lastRun: null,
      heldSummary: () => [
        { collateral: 'BTC', market: 'MUSD', amount: '0.01', cost: '780', minProceeds: '780', since: 0, redeemed: null },
        {
          collateral: 'pMEZO',
          market: 'MUSD',
          amount: '0',
          cost: '0',
          minProceeds: '0',
          since: 0,
          redeemed: { asset: 'MEZO', amount: '250000', cost: '1100' },
        },
      ],
      pendingTransactions: () => [],
      store: { get: () => ({ accounts: ['0xa'] }) },
    },
    watchdog: {
      status: () =>
        o.oracle?.report === false
          ? { report: null, stale: true, ageSec: null, error: null }
          : { report, stale: o.oracle?.stale ?? false, ageSec: o.oracle?.stale ? 600 : 5, error: o.oracle?.stale ? 'HTTP request failed.' : null },
    },
    pusher: { status: () => ({ enabled: false, notEntitled: [], lastPush: null }) },
    watch: {
      queued: o.events ?? [],
      drain() {
        const out = this.queued;
        this.queued = [];
        return out;
      },
      recent: () => o.events ?? [],
      lastError: null,
      counts: { 'VaultManager.TreasurySet': (o.events ?? []).length },
    },
    revenue: {
      report: () => ({
        markets: [{ market: 'MUSD', totalReserves: '12.5', totalReservesUsd: 12.4, flashFees: '0.9' }],
        liquidationFees: [{ symbol: 'BTC', treasuryBalance: '0.0005', treasuryBalanceUsd: 41 }],
      }),
    },
  };
  const monitor = new Monitor(services as never, now);
  return { monitor, logs, setNow: (v: number) => (t = v) };
}

describe('health checks (health-monitoring-gaps)', () => {
  it('reports ok with balances, backlog and inventory when every check passes', async () => {
    const { monitor } = monitorWith({});
    await monitor.sampleBalances();
    const r = monitor.report();
    expect(r).toMatchObject({ ok: true, status: 'ok', env: 'testnet', keeper: '0x00000000000000000000000000000000000000ee' });
    expect(r.balances.map((b) => [b.network, b.balance, b.ok])).toEqual([
      ['mezo-testnet', '1', true],
      ['base-sepolia', '1', true],
    ]);
    expect(r.keeperInventory).toEqual({ MUSD: '50.0' });
    expect(r.heldCollateral).toHaveLength(2);
    expect(r.deployment.hub).toMatchObject({ vaultManager: '0x01', startBlock: 1 });
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it('is degraded when the keeper runs low on gas on any chain', async () => {
    const { monitor } = monitorWith({ balances: { 'base-sepolia': parseEther('0.001') } });
    await monitor.sampleBalances();
    const r = monitor.report();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'gas:base-sepolia')).toMatchObject({
      ok: false,
      severity: 'critical',
      detail: '0.001 ETH (minimum 0.002: fund the keeper)',
    });
  });

  it('is degraded when the oracle has no usable price for a feed, or its report went stale', () => {
    expect(
      monitorWith({ oracle: { healthy: false } })
        .monitor.report()
        .checks.find((c) => c.name === 'oracle'),
    ).toMatchObject({ ok: false, severity: 'critical' });
    const stale = monitorWith({ oracle: { stale: true } }).monitor.report();
    expect(stale.ok).toBe(false);
    expect(stale.checks.find((c) => c.name === 'oracle')!.detail).toBe('report is 600 s old; checks fail: HTTP request failed.');
  });

  it('is degraded when a message this agent should deliver is pending past 3× finality', () => {
    const r = monitorWith({ messages: [pendingMessage({ observedAt: 0, attempts: 7, lastError: 'execution reverted', status: 'ready' })] }).monitor.report();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'relayer:backlog')!.detail).toMatch(
      /^1 message\(s\) pending past 3× source finality; oldest 10004\/0xab\/1 \(ready, 1000 s, execution reverted\)$/,
    );
  });

  it('warns, without failing /health, about liquidatable accounts left alone and a high revert rate', () => {
    const { monitor } = monitorWith({
      skipped: { 'no repay inventory': 2, 'read-only': 1 },
      hubSender: sender({ revertRate: () => 0.4, recent: new Array(10).fill('reverted') }),
    });
    const r = monitor.report();
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'liquidator:queue')).toMatchObject({
      ok: false,
      severity: 'warning',
      detail: 'liquidatable accounts left alone: 2 no repay inventory',
    });
    expect(r.checks.find((c) => c.name === 'tx:mezo-testnet')).toMatchObject({
      ok: false,
      severity: 'warning',
      detail: '40% of the last 10 transactions reverted',
    });
  });

  it('is degraded when a source network cannot be scanned for minutes (its messages go unseen)', () => {
    const brief = monitorWith({ failingScans: [{ network: 'base-sepolia', since: 1_000_000 - 30_000, error: 'HTTP request failed.' }] }).monitor.report();
    expect(brief.checks.find((c) => c.name === 'relayer:scan')).toMatchObject({ ok: true, detail: 'base-sepolia failing for 30 s: HTTP request failed.' });
    const long = monitorWith({ failingScans: [{ network: 'base-sepolia', since: 0, error: 'HTTP request failed.' }] }).monitor.report();
    expect(long.ok).toBe(false);
    expect(long.checks.find((c) => c.name === 'relayer:scan')).toMatchObject({ ok: false, severity: 'critical' });
  });

  it('is degraded while a keeper transaction is stuck unmined', () => {
    const r = monitorWith({ hubSender: sender({ stuckSince: 0 }) }).monitor.report();
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'tx:mezo-testnet')).toMatchObject({ ok: false, severity: 'critical' });
  });

  it('recovers once the stuck transaction is mined, even when the keeper sends nothing afterwards (final review A6)', async () => {
    const chain = scriptedChain();
    const keeper = new TxSender('mezo-testnet', chain.client, chain.wallet, { receiptTimeoutMs: 20, pollMs: 2, log: () => {} });
    const request = { address: '0x00000000000000000000000000000000000000ab', abi: spokeGatewayAbi, functionName: 'receiveMessage', args: ['0x01'] };
    const stuck = (await keeper.send(request, { kind: 'relay-release' }).catch((e: unknown) => e)) as StuckTransactionError;
    expect(stuck).toBeInstanceOf(StuckTransactionError);
    const { monitor, logs } = monitorWith({ hubSender: keeper });
    await monitor.tick();
    expect(monitor.report().checks.find((c) => c.name === 'tx:mezo-testnet')).toMatchObject({ ok: false, severity: 'critical' });
    chain.mine(stuck.hashes.at(-1)!); // its last fee bump is mined; the relayer then finds the VAA consumed and sends nothing
    await monitor.tick();
    expect(monitor.report().checks.find((c) => c.name === 'tx:mezo-testnet')).toMatchObject({ ok: true });
    expect(logs).toContain('recovered: tx:mezo-testnet');
    expect(monitor.metrics()).toContain('mezodot_agent_transaction_stuck{env="testnet",network="mezo-testnet"} 0');
  });

  it('flags loops that stopped succeeding', async () => {
    let t = 0;
    const { monitor } = monitorWith({ now: () => t });
    const loops = (monitor as unknown as { s: { loops: Loops } }).s.loops;
    loops.every('relayer', 6_000, async () => Promise.reject(new Error('rpc down')));
    await flush();
    loops.stop();
    t = 10 * 60_000;
    const relayer = monitor.report().checks.find((c) => c.name === 'loop:relayer')!;
    expect(relayer).toMatchObject({ ok: false, severity: 'critical' });
    expect(relayer.detail).toMatch(/no successful run since start \(1 failures in a row; last error: rpc down\)/);
  });
});

describe('alerts and metrics', () => {
  it('posts health changes to ALERT_WEBHOOK_URL once per change, retrying until delivered', async () => {
    const posts: { url: string; body: { status: string; text: string; content: string; changes: { name: string; ok: boolean }[] } }[] = [];
    let up = false;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (!up) return new Response('down', { status: 502 });
      posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const balances: Record<string, bigint> = { 'mezo-testnet': parseEther('0.00005') };
    const { monitor, logs } = monitorWith({ webhook: 'https://hooks.example/T/B/X', fetch: fetchImpl, balances });
    await monitor.tick(); // gas on Mezo is low: a change, but the webhook is down
    expect(posts).toEqual([]);
    expect(logs).toContain('alert webhook failed; will retry');
    up = true;
    await monitor.tick(); // no new change: the undelivered alert goes out now
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ status: 'degraded', changes: [{ name: 'gas:mezo-testnet', ok: false }] });
    expect(posts[0].body.text).toMatch(/^mezodot-agent testnet DEGRADED: failing gas:mezo-testnet/);
    await monitor.tick(); // nothing changed: nothing sent
    expect(posts).toHaveLength(1);
    balances['mezo-testnet'] = parseEther('1');
    await monitor.tick();
    expect(posts).toHaveLength(2);
    expect(posts[1].body).toMatchObject({ status: 'ok', changes: [{ name: 'gas:mezo-testnet', ok: true }] });
    expect(logs).toContain('recovered: gas:mezo-testnet');
  });

  it('pushes owner and risk-parameter events to the webhook as they are found', async () => {
    const posts: { events: { event: string }[]; text: string }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => (posts.push(JSON.parse(String(init.body))), new Response('ok'))) as unknown as typeof fetch;
    const event = { kind: 'control', network: 'mezo-testnet', label: 'VaultManager', event: 'TreasurySet', txHash: '0xabc', args: { treasury: '0xbad' } };
    const { monitor } = monitorWith({ webhook: 'https://hooks.example/x', fetch: fetchImpl, events: [event] });
    await monitor.tick();
    expect(posts).toHaveLength(1);
    expect(posts[0].events.map((e) => e.event)).toEqual(['TreasurySet']);
    expect(posts[0].text).toMatch(/control event VaultManager\.TreasurySet on mezo-testnet \(tx 0xabc\)/);
    await monitor.tick();
    expect(posts).toHaveLength(1); // delivered once
    expect(monitor.report().adminEvents.recent).toHaveLength(1);
    expect(monitor.metrics()).toContain('mezodot_agent_admin_events_total{env="testnet",contract="VaultManager",event="TreasurySet"} 1');
  });

  it('exposes Prometheus text with loops, balances, backlog, held collateral and revenue', async () => {
    const { monitor } = monitorWith({});
    await monitor.sampleBalances();
    const text = monitor.metrics();
    for (const line of text.trim().split('\n')) expect(line).toMatch(/^(# (HELP|TYPE) \S+ .+|[a-z_]+(\{[^}]*\})? -?[\d.e+-]+)$/);
    expect(text).toContain('mezodot_agent_degraded{env="testnet"} 0');
    expect(text).toContain('mezodot_agent_native_balance{env="testnet",network="base-sepolia",symbol="ETH"} 1');
    expect(text).toContain('mezodot_agent_inventory{env="testnet",asset="MUSD"} 50');
    expect(text).toContain('mezodot_agent_held_collateral{env="testnet",collateral="BTC",market="MUSD"} 0.01');
    expect(text).toContain('mezodot_agent_held_redeemed{env="testnet",collateral="pMEZO",market="MUSD",asset="MEZO"} 250000');
    expect(text).toContain('mezodot_agent_liquidator_pending_transactions{env="testnet"} 0');
    expect(text).toContain('mezodot_protocol_reserves{env="testnet",market="MUSD"} 12.5');
    expect(text).toContain('mezodot_protocol_treasury_collateral_usd{env="testnet",collateral="BTC"} 41');
    expect(text).toContain('# TYPE mezodot_protocol_flash_fees_total counter');
  });
});
