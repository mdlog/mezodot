import type { Context } from './context';
import { Monitor } from './health';
import { Liquidator } from './liquidator';
import { Loops } from './loops';
import { OracleRelay } from './oracle/relay';
import { PythPusher } from './oracle/pusher';
import { OracleWatchdog } from './oracle/watchdog';
import { Relayer } from './relayer';
import { RevenueTracker } from './revenue';
import { RiskEngine } from './risk/report';
import { AdminWatch } from './watch';

/** Long-lived agent components shared by the loops, the HTTP API and the MCP server. */
export type Services = {
  ctx: Context;
  loops: Loops;
  relayer: Relayer;
  liquidator: Liquidator;
  risk: RiskEngine;
  oracle: OracleRelay;
  watchdog: OracleWatchdog;
  pusher: PythPusher;
  revenue: RevenueTracker;
  watch: AdminWatch;
  monitor: Monitor;
};

export function createServices(ctx: Context): Services {
  const oracle = new OracleRelay(ctx);
  const services: Omit<Services, 'monitor'> = {
    ctx,
    loops: new Loops(ctx.log),
    relayer: new Relayer(ctx),
    liquidator: new Liquidator(ctx, oracle),
    risk: new RiskEngine(ctx, ctx.fetch, oracle),
    oracle,
    watchdog: new OracleWatchdog(ctx, oracle),
    pusher: new PythPusher(ctx, oracle),
    revenue: new RevenueTracker(ctx, oracle),
    watch: new AdminWatch(ctx),
  };
  const all = services as Services;
  all.monitor = new Monitor(all);
  return all;
}

/** JSON with bigint support (bigints become decimal strings). */
export const toJson = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
