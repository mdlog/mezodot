import type { Context } from './context';
import { Liquidator } from './liquidator';
import { Relayer } from './relayer';
import { RiskEngine } from './risk/report';

/** Long-lived agent components shared by the loops, the HTTP API and the MCP server. */
export type Services = {
  ctx: Context;
  relayer: Relayer;
  liquidator: Liquidator;
  risk: RiskEngine;
};

export const createServices = (ctx: Context): Services => ({
  ctx,
  relayer: new Relayer(ctx),
  liquidator: new Liquidator(ctx),
  risk: new RiskEngine(ctx),
});

/** JSON with bigint support (bigints become decimal strings). */
export const toJson = (value: unknown): string => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
