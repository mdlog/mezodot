import { formatEther } from 'viem';
import { NETWORKS, type NetworkName } from '@mezodot/sdk';
import { deploymentIdentity } from './context';
import { publicError } from './errors';
import type { LoopStats } from './loops';
import type { Services } from './services';
import type { TxSender } from './tx';
import type { AdminEvent } from './watch';

export type CheckSeverity = 'critical' | 'warning';
/** One health condition. A failing critical check makes /health answer 503. */
export type HealthCheck = { name: string; ok: boolean; severity: CheckSeverity; detail: string };

export type NativeBalance = {
  network: NetworkName;
  symbol: string;
  /** Whole units; null until sampled. */
  balance: string | null;
  minimum: string;
  ok: boolean | null;
  sampledAt: number | null;
  error: string | null;
};

/** A loop is stale once its last success is older than this many intervals (and at least STALE_MIN_MS). */
const STALE_INTERVALS = 3;
const STALE_MIN_MS = 2 * 60_000;
/** A run in flight longer than this many intervals (and at least HUNG_MIN_MS) is hung. */
const HUNG_INTERVALS = 10;
const HUNG_MIN_MS = 5 * 60_000;
/** Balance samples older than this count as unknown. */
const BALANCE_MAX_AGE_MS = 5 * 60_000;
/** Share of recent transactions that reverted above which the revert-rate check warns. */
const MAX_REVERT_RATE = 0.25;
/** Alerts kept for redelivery while the webhook fails. */
const MAX_UNDELIVERED = 50;

const secs = (ms: number) => Math.round(ms / 1000);

export function loopCheck(l: LoopStats, now: number, startedAt: number): HealthCheck {
  const name = `loop:${l.name}`;
  const severity: CheckSeverity = l.critical ? 'critical' : 'warning';
  const hungMs = Math.max(HUNG_INTERVALS * l.intervalMs, HUNG_MIN_MS);
  const staleMs = Math.max(STALE_INTERVALS * l.intervalMs, STALE_MIN_MS);
  const lastError = l.lastError ? `; last error: ${l.lastError}` : '';
  if (l.runningSince !== null && now - l.runningSince > hungMs) {
    return { name, ok: false, severity, detail: `a run has been in flight for ${secs(now - l.runningSince)} s${lastError}` };
  }
  const since = l.lastSuccessAt ?? startedAt;
  if (now - since > staleMs && l.runningSince === null) {
    const what = l.lastSuccessAt === null ? 'no successful run since start' : `no successful run for ${secs(now - since)} s`;
    return { name, ok: false, severity, detail: `${what} (${l.consecutiveFailures} failures in a row${lastError})` };
  }
  const last = l.lastSuccessAt === null ? 'starting' : `last success ${secs(now - l.lastSuccessAt)} s ago`;
  return { name, ok: true, severity, detail: l.consecutiveFailures > 0 ? `${last}, ${l.consecutiveFailures} failures since${lastError}` : last };
}

/**
 * Derives the agent's health from its loops, the oracle watchdog, keeper gas on every chain, the relayer backlog
 * and the keeper's transactions; serves it as /health and /metrics and pushes state changes to ALERT_WEBHOOK_URL.
 */
export class Monitor {
  private readonly balances = new Map<NetworkName, NativeBalance & { wei: bigint | null }>();
  private previous = new Map<string, HealthCheck>();
  private undelivered: HealthCheck[] = [];
  private undeliveredEvents: AdminEvent[] = [];
  private webhookFailing = false;
  /** Unhandled promise rejections seen by the process (index.ts). */
  unhandledRejections = 0;

  constructor(
    private readonly s: Services,
    private readonly now: () => number = Date.now,
  ) {}

  /** Chains the keeper sends on, with their sender. */
  private senders(): { network: NetworkName; sender: TxSender }[] {
    const { ctx } = this.s;
    const out: { network: NetworkName; sender: TxSender }[] = [];
    if (ctx.hub.sender) out.push({ network: ctx.hub.network, sender: ctx.hub.sender });
    // Spokes only see release relays.
    if (ctx.config.modules.has('relayer')) for (const sp of ctx.spokes) if (sp.sender) out.push({ network: sp.network, sender: sp.sender });
    return out;
  }

  /** Reads the keeper's native balance on every chain it sends on. */
  async sampleBalances(): Promise<void> {
    const { ctx } = this.s;
    await Promise.all(
      this.senders().map(async ({ network, sender }) => {
        const chain = network === ctx.hub.network ? ctx.hub : ctx.spokes.find((sp) => sp.network === network)!;
        const minimum = ctx.config.minGasBalance?.[network] ?? 0n;
        const symbol = NETWORKS[network].chain.nativeCurrency.symbol;
        const prev = this.balances.get(network);
        try {
          const wei = await chain.client.getBalance({ address: sender.address });
          this.balances.set(network, {
            network,
            symbol,
            wei,
            balance: formatEther(wei),
            minimum: formatEther(minimum),
            ok: wei >= minimum,
            sampledAt: this.now(),
            error: null,
          });
        } catch (err) {
          this.balances.set(network, {
            ...(prev ?? { network, symbol, wei: null, balance: null, minimum: formatEther(minimum), ok: null, sampledAt: null }),
            error: publicError(err),
          });
        }
      }),
    );
  }

  checks(now = this.now()): HealthCheck[] {
    const { ctx, relayer, liquidator, watchdog } = this.s;
    const modules = ctx.config.modules;
    const startedAt = this.s.loops.startedAt;
    const out: HealthCheck[] = this.s.loops
      .snapshot()
      .filter((l) => l.name !== 'monitor')
      .map((l) => loopCheck(l, now, startedAt));

    if (modules.has('oracle')) {
      const st = watchdog.status();
      const graceMs = 2 * ctx.config.oracleWatchMs;
      let check: Omit<HealthCheck, 'name' | 'severity'>;
      if (!st.report) check = { ok: now - startedAt < graceMs, detail: st.error ? `no report: ${st.error}` : 'no report yet' };
      else if (st.stale) check = { ok: false, detail: `report is ${st.ageSec} s old${st.error ? `; checks fail: ${st.error}` : ''}` };
      else if (!st.report.healthy) {
        const down = st.report.feeds.filter((f) => f.status === 'unavailable').map((f) => f.symbol);
        check = { ok: false, detail: `no usable price and nobody can refresh it: ${down.join(', ')} (risk checks touching them revert)` };
      } else {
        const expiring = st.report.feeds.filter((f) => f.status === 'expiring').map((f) => f.symbol);
        check = { ok: true, detail: expiring.length > 0 ? `usable; expiring soon: ${expiring.join(', ')}` : 'usable' };
      }
      out.push({ name: 'oracle', severity: 'critical', ...check });
    }

    for (const { network } of this.senders()) {
      const b = this.balances.get(network);
      const name = `gas:${network}`;
      if (!b || (b.sampledAt === null && !b.error)) out.push({ name, ok: true, severity: 'critical', detail: 'not sampled yet' });
      else if (b.sampledAt === null || now - b.sampledAt > BALANCE_MAX_AGE_MS)
        out.push({ name, ok: false, severity: 'warning', detail: `balance unknown${b.error ? `: ${b.error}` : ''}` });
      else
        out.push({
          name,
          ok: b.ok === true,
          severity: 'critical',
          detail: `${b.balance} ${b.symbol} (minimum ${b.minimum}${b.ok ? '' : ': fund the keeper'})`,
        });
    }

    if (modules.has('relayer')) {
      const stuck = relayer.pending().filter((m) => relayer.isStuck(m, now));
      const ours = stuck.filter((m) => relayer.canDeliver(m.target));
      const oldest = stuck.reduce<(typeof stuck)[number] | null>((o, m) => (!o || m.observedAt < o.observedAt ? m : o), null);
      out.push({
        name: 'relayer:backlog',
        ok: stuck.length === 0,
        severity: ours.length > 0 ? 'critical' : 'warning',
        detail:
          stuck.length === 0
            ? `${relayer.pending().length} pending, none past 3× finality`
            : `${stuck.length} message(s) pending past 3× source finality; oldest ${oldest!.id} (${oldest!.status}, ${secs(now - oldest!.observedAt)} s${oldest!.lastError ? `, ${oldest!.lastError}` : ''})`,
      });
      const failing = relayer.failingScans?.() ?? [];
      const longFailing = failing.filter((f) => now - f.since > Math.max(STALE_INTERVALS * ctx.config.pollMs, STALE_MIN_MS));
      out.push({
        name: 'relayer:scan',
        ok: longFailing.length === 0,
        severity: 'critical',
        detail: failing.length === 0 ? 'every source scanned' : failing.map((f) => `${f.network} failing for ${secs(now - f.since)} s: ${f.error}`).join('; '),
      });
      const gaps = relayer.gaps();
      out.push({
        name: 'relayer:sequences',
        ok: gaps.length === 0,
        severity: 'warning',
        detail: gaps.length === 0 ? 'no gaps' : gaps.map((g) => `${g.emitter} missing ${g.missing.join(', ')}`).join('; '),
      });
    }

    if (modules.has('liquidator')) {
      const tick = liquidator.lastTick;
      const skipped = tick ? Object.entries(tick.skipped).filter(([reason]) => reason !== 'read-only') : [];
      const reasons = skipped.map(([reason, n]) => `${n} ${reason}`).join(', ');
      out.push({
        name: 'liquidator:queue',
        ok: skipped.length === 0 && liquidator.syncError === null,
        severity: 'warning',
        detail:
          liquidator.syncError !== null
            ? `borrower index sync failing: ${liquidator.syncError}`
            : skipped.length > 0
              ? `liquidatable accounts left alone: ${reasons}`
              : tick
                ? `${tick.liquidatable} liquidatable, ${tick.liquidated} liquidated last tick`
                : 'no tick yet',
      });
    }

    for (const { network, sender } of this.senders()) {
      if (sender.stuckSince !== null) {
        out.push({
          name: `tx:${network}`,
          ok: false,
          severity: 'critical',
          detail: `keeper transaction unmined since ${new Date(sender.stuckSince).toISOString()}`,
        });
        continue;
      }
      const rate = sender.revertRate();
      out.push({
        name: `tx:${network}`,
        ok: rate === null || rate <= MAX_REVERT_RATE,
        severity: 'warning',
        detail: rate === null ? 'few transactions yet' : `${Math.round(rate * 100)}% of the last ${sender.recent.length} transactions reverted`,
      });
    }
    return out;
  }

  report(now = this.now()) {
    const { ctx, relayer, liquidator, watchdog, pusher } = this.s;
    const checks = this.checks(now);
    const degraded = checks.some((c) => !c.ok && c.severity === 'critical');
    const oracle = watchdog.status();
    return {
      ok: !degraded,
      status: degraded ? 'degraded' : 'ok',
      env: ctx.config.env,
      modules: [...ctx.config.modules],
      keeper: ctx.hub.wallet?.account.address ?? null,
      startedAt: this.s.loops.startedAt,
      uptimeSec: secs(now - this.s.loops.startedAt),
      deployment: deploymentIdentity(ctx),
      checks,
      loops: this.s.loops.snapshot(),
      balances: [...this.balances.values()].map(({ wei: _wei, ...b }) => b),
      keeperInventory: liquidator.lastInventory,
      heldCollateral: liquidator.heldSummary(),
      backlog: {
        relayer: relayer.summary(now),
        liquidator: {
          indexed: liquidator.store.get().accounts.length,
          lastTick: liquidator.lastTick,
          syncError: liquidator.syncError,
          // Sent and not settled yet (stuck, or receipts not found yet): settled from chain state every tick.
          pendingTransactions: liquidator.pendingTransactions(),
        },
      },
      oracle: { healthy: oracle.report?.healthy ?? null, checkedAt: oracle.report?.checkedAt ?? null, stale: oracle.stale, error: oracle.error },
      pythPusher: pusher?.status() ?? null,
      transactions: Object.fromEntries(
        this.senders().map(({ network, sender }) => [
          network,
          { counts: sender.counts, revertRate: sender.revertRate(), stuckSince: sender.stuckSince, lastError: sender.lastError },
        ]),
      ),
      liquidatorLastRun: liquidator.lastRun,
      adminEvents: { recent: this.s.watch?.recent().slice(0, 10) ?? [], error: this.s.watch?.lastError ?? null },
    };
  }

  /** Prometheus text exposition (version 0.0.4). */
  metrics(now = this.now()): string {
    const { ctx, relayer, liquidator, watchdog, revenue } = this.s;
    const m = new MetricsWriter({ env: ctx.config.env });
    const checks = this.checks(now);
    m.gauge('mezodot_agent_up', 'Always 1 while the agent answers.', [[{}, 1]]);
    m.gauge('mezodot_agent_degraded', '1 when a critical health check fails (/health answers 503).', [
      [{}, checks.some((c) => !c.ok && c.severity === 'critical') ? 1 : 0],
    ]);
    m.gauge(
      'mezodot_agent_check_ok',
      'Health check state (1 ok, 0 failing).',
      checks.map((c) => [{ check: c.name, severity: c.severity }, c.ok ? 1 : 0]),
    );
    const loops = this.s.loops.snapshot();
    m.counter(
      'mezodot_agent_loop_runs_total',
      'Loop runs.',
      loops.map((l) => [{ loop: l.name }, l.runs]),
    );
    m.counter(
      'mezodot_agent_loop_failures_total',
      'Loop runs that failed.',
      loops.map((l) => [{ loop: l.name }, l.failures]),
    );
    m.gauge(
      'mezodot_agent_loop_consecutive_failures',
      'Failed runs in a row.',
      loops.map((l) => [{ loop: l.name }, l.consecutiveFailures]),
    );
    m.gauge(
      'mezodot_agent_loop_last_success_timestamp_seconds',
      'Unix time of the last successful run.',
      loops.filter((l) => l.lastSuccessAt !== null).map((l) => [{ loop: l.name }, l.lastSuccessAt! / 1000]),
    );
    m.gauge(
      'mezodot_agent_loop_last_duration_seconds',
      'Duration of the last run.',
      loops.filter((l) => l.lastDurationMs !== null).map((l) => [{ loop: l.name }, l.lastDurationMs! / 1000]),
    );
    const balances = [...this.balances.values()].filter((b) => b.wei !== null);
    m.gauge(
      'mezodot_agent_native_balance',
      'Keeper native balance (whole units).',
      balances.map((b) => [{ network: b.network, symbol: b.symbol }, Number(b.balance)]),
    );
    m.gauge(
      'mezodot_agent_native_balance_minimum',
      'Configured minimum native balance.',
      balances.map((b) => [{ network: b.network, symbol: b.symbol }, Number(b.minimum)]),
    );
    m.gauge(
      'mezodot_agent_inventory',
      'Keeper balance of each debt asset (whole units).',
      Object.entries(liquidator.lastInventory).map(([asset, v]) => [{ asset }, Number(v)]),
    );

    const sum = relayer.summary(now);
    m.gauge('mezodot_agent_relayer_pending_messages', 'Messages observed and not delivered.', [
      [{ status: 'waiting_vaa' }, sum.waitingVaa],
      [{ status: 'ready' }, sum.ready],
    ]);
    m.gauge('mezodot_agent_relayer_stuck_messages', 'Pending messages older than 3x their source finality.', [[{}, sum.stuck.length]]);
    m.gauge(
      'mezodot_agent_relayer_oldest_pending_age_seconds',
      'Age of the oldest pending message.',
      sum.oldestPendingAgeSec === null ? [] : [[{}, sum.oldestPendingAgeSec]],
    );
    m.gauge('mezodot_agent_relayer_sequence_gaps', 'Emitters with a sequence missing from the logs.', [[{}, sum.gaps.length]]);
    m.gauge(
      'mezodot_agent_relayer_scan_failing_seconds',
      'How long the log scan of a source network has been failing.',
      (relayer.failingScans?.() ?? []).map((f) => [{ network: f.network }, (now - f.since) / 1000]),
    );

    const oracle = watchdog.status();
    if (oracle.report) {
      m.gauge('mezodot_agent_oracle_healthy', '1 when every configured feed can be priced.', [[{}, oracle.report.healthy ? 1 : 0]]);
      m.gauge('mezodot_agent_oracle_report_age_seconds', 'Age of the last oracle check.', [[{}, oracle.ageSec ?? 0]]);
      m.gauge(
        'mezodot_agent_oracle_feed_valid_seconds',
        'Seconds each feed stays usable (0 when it needs a pull update or is unavailable).',
        oracle.report.feeds.map((f) => [{ symbol: f.symbol, status: f.status }, f.validForSec]),
      );
    }

    const tick = liquidator.lastTick;
    m.gauge('mezodot_agent_liquidator_indexed_accounts', 'Borrowers in the liquidator index.', [[{}, liquidator.store.get().accounts.length]]);
    if (tick) {
      m.gauge('mezodot_agent_liquidator_liquidatable_accounts', 'Accounts below health factor 1 at the last tick.', [[{}, tick.liquidatable]]);
      m.gauge(
        'mezodot_agent_liquidator_skipped_accounts',
        'Liquidatable accounts left alone at the last tick, by reason.',
        Object.entries(tick.skipped).map(([reason, n]) => [{ reason }, n]),
      );
    }
    const held = liquidator.heldSummary();
    m.gauge(
      'mezodot_agent_held_collateral',
      'Seized collateral not converted back into a debt asset yet (whole units).',
      held.map((h) => [{ collateral: h.collateral, market: h.market }, Number(h.amount)]),
    );
    m.gauge(
      'mezodot_agent_held_redeemed',
      'What seized pTokens of another asset than the debt redeemed into and is not sold yet (whole units of that asset).',
      held.flatMap((h) => (h.redeemed ? [[{ collateral: h.collateral, market: h.market, asset: h.redeemed.asset }, Number(h.redeemed.amount)] as const] : [])),
    );
    m.gauge('mezodot_agent_liquidator_pending_transactions', 'Liquidator transactions sent and not settled yet.', [
      [{}, liquidator.pendingTransactions().length],
    ]);

    const txs = this.senders().flatMap(({ network, sender }) =>
      Object.entries(sender.counts).flatMap(([kind, outcomes]) =>
        Object.entries(outcomes).map(([outcome, n]) => [{ network, kind, outcome }, n ?? 0] as const),
      ),
    );
    m.counter('mezodot_agent_transactions_total', 'Keeper transactions by call kind and outcome.', txs);
    m.gauge(
      'mezodot_agent_transaction_stuck',
      '1 while a keeper transaction stays unmined.',
      this.senders().map(({ network, sender }) => [{ network }, sender.stuckSince === null ? 0 : 1]),
    );
    m.counter('mezodot_agent_unhandled_rejections_total', 'Unhandled promise rejections.', [[{}, this.unhandledRejections]]);
    m.counter(
      'mezodot_agent_admin_events_total',
      'Owner and risk-parameter events seen since the agent started (VaultManager.TreasurySet, OracleRouter.FeedSet, …).',
      Object.entries(this.s.watch?.counts ?? {}).map(([key, n]) => {
        const dot = key.lastIndexOf('.');
        return [{ contract: key.slice(0, dot), event: key.slice(dot + 1) }, n] as const;
      }),
    );

    const r = revenue.report();
    if (r) {
      m.gauge(
        'mezodot_protocol_reserves',
        'Pool reserves (whole units of the market asset).',
        r.markets.map((x) => [{ market: x.market }, Number(x.totalReserves)]),
      );
      m.gauge(
        'mezodot_protocol_reserves_usd',
        'Pool reserves in USD.',
        r.markets.filter((x) => x.totalReservesUsd !== null).map((x) => [{ market: x.market }, x.totalReservesUsd!]),
      );
      m.counter(
        'mezodot_protocol_flash_fees_total',
        'Lifetime flash-loan fees (whole units).',
        r.markets.map((x) => [{ market: x.market }, Number(x.flashFees)]),
      );
      m.gauge(
        'mezodot_protocol_treasury_collateral',
        'Treasury collateral in VaultManager custody (whole units; shares for pTokens).',
        r.liquidationFees.map((x) => [{ collateral: x.symbol }, Number(x.treasuryBalance)]),
      );
      m.gauge(
        'mezodot_protocol_treasury_collateral_usd',
        'Treasury collateral in USD.',
        r.liquidationFees.filter((x) => x.treasuryBalanceUsd !== null).map((x) => [{ collateral: x.symbol }, x.treasuryBalanceUsd!]),
      );
    }
    return m.text();
  }

  /**
   * Samples balances and clears a stuck state whose nonce has been mined since (also when nothing else is sent
   * afterwards), then logs and pushes every health check that changed state and every new admin event.
   */
  async tick(): Promise<void> {
    await Promise.all([this.sampleBalances(), ...this.senders().map(({ sender }) => sender.refreshStuck().catch(() => undefined))]);
    await this.alert();
  }

  async alert(now = this.now()): Promise<void> {
    const checks = this.checks(now);
    const changes = checks.filter((c) => {
      const before = this.previous.get(c.name);
      return before ? before.ok !== c.ok : !c.ok;
    });
    this.previous = new Map(checks.map((c) => [c.name, c]));
    for (const c of changes) this.s.ctx.log('health', c.ok ? `recovered: ${c.name}` : `failing: ${c.name}`, { severity: c.severity, detail: c.detail });
    const fresh = this.s.watch?.drain() ?? [];
    const url = this.s.ctx.config.alertWebhookUrl;
    if (!url) return;
    const pending = [...this.undelivered, ...changes].slice(-MAX_UNDELIVERED);
    const events = [...this.undeliveredEvents, ...fresh].slice(-MAX_UNDELIVERED);
    if (pending.length === 0 && events.length === 0) return;
    const degraded = checks.some((c) => !c.ok && c.severity === 'critical');
    const lines = [
      ...pending.map((c) => `${c.ok ? 'recovered' : 'failing'} ${c.name} (${c.detail})`),
      ...events.map((e) => `${e.kind} event ${e.label}.${e.event} on ${e.network} (tx ${e.txHash})`),
    ];
    const text = `mezodot-agent ${this.s.ctx.config.env} ${degraded ? 'DEGRADED' : 'ok'}: ${lines.join('; ')}`;
    const body = {
      source: 'mezodot-agent',
      env: this.s.ctx.config.env,
      status: degraded ? 'degraded' : 'ok',
      at: new Date(now).toISOString(),
      changes: pending,
      events,
      // Plain-text fields so Slack/Mattermost (`text`) and Discord (`content`) webhooks render it as is.
      text,
      content: text.slice(0, 2_000),
    };
    try {
      const res = await (this.s.ctx.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`alert webhook answered HTTP ${res.status}`);
      this.undelivered = [];
      this.undeliveredEvents = [];
      this.webhookFailing = false;
    } catch (err) {
      this.undelivered = pending;
      this.undeliveredEvents = events;
      if (!this.webhookFailing) this.s.ctx.log('health', 'alert webhook failed; will retry', { error: publicError(err) });
      this.webhookFailing = true;
    }
  }
}

type Labels = Record<string, string | number>;

/** Minimal Prometheus text writer: HELP/TYPE once per metric, escaped labels, finite values only. */
class MetricsWriter {
  private readonly lines: string[] = [];

  constructor(private readonly base: Labels) {}

  gauge(name: string, help: string, samples: readonly (readonly [Labels, number])[]): void {
    this.metric(name, 'gauge', help, samples);
  }

  counter(name: string, help: string, samples: readonly (readonly [Labels, number])[]): void {
    this.metric(name, 'counter', help, samples);
  }

  text(): string {
    return `${this.lines.join('\n')}\n`;
  }

  private metric(name: string, type: 'gauge' | 'counter', help: string, samples: readonly (readonly [Labels, number])[]): void {
    const finite = samples.filter(([, v]) => Number.isFinite(v));
    if (finite.length === 0) return;
    this.lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of finite) this.lines.push(`${name}${this.labels({ ...this.base, ...labels })} ${value}`);
  }

  private labels(labels: Labels): string {
    const parts = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
    return parts.length > 0 ? `{${parts.join(',')}}` : '';
  }
}
