import type { Context } from './context';
import { Liquidator } from './liquidator';
import { OracleRelay } from './oracle/relay';
import { PythPusher } from './oracle/pusher';
import { OracleWatchdog } from './oracle/watchdog';
import { Relayer } from './relayer';
import { RiskEngine } from './risk/report';

/** Long-lived agent components shared by the loops, the HTTP API and the MCP server. */
export type Services = {
  ctx: Context;
  relayer: Relayer;
  liquidator: Liquidator;
  risk: RiskEngine;
  oracle: OracleRelay;
  watchdog: OracleWatchdog;
  pusher: PythPusher;
};

export function createServices(ctx: Context): Services {
  const oracle = new OracleRelay(ctx);
  return {
    ctx,
    relayer: new Relayer(ctx),
    liquidator: new Liquidator(ctx, oracle),
    risk: new RiskEngine(ctx),
    oracle,
    watchdog: new OracleWatchdog(ctx, oracle),
    pusher: new PythPusher(ctx, oracle),
  };
}

/** JSON with bigint support (bigints become decimal strings). */
export const toJson = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
