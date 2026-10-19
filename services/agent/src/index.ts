import { accessSync, constants, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { ConfigError, describeConfig, loadConfig, type AgentConfig } from './config';
import { createContext, deploymentIdentity, logJson } from './context';
import { publicError } from './errors';
import { startHttp } from './http';
import { createServices } from './services';

const RISK_INTERVAL_MS = 30 * 60_000;
const REVENUE_INTERVAL_MS = 5 * 60_000;
/** Owner and risk-parameter events on the hub and spokes are looked for this often. */
const WATCH_INTERVAL_MS = 60_000;
/** Keeper balances are sampled and health changes alerted this often. */
const MONITOR_INTERVAL_MS = 30_000;
/** How long a shutdown waits for runs in flight (receipts, seized-collateral sales); compose allows 2 min. */
const SHUTDOWN_GRACE_MS = 100_000;

function configOrExit(): AgentConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    logJson('agent', 'invalid configuration; not starting', { issues: err.issues });
    process.exit(1);
  }
}

/** Fails fast when the state directory cannot be written (e.g. a volume created by an older, root-run image). */
function requireWritable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch (err) {
    logJson('agent', `STATE_DIR ${dir} is not writable by this user (uid ${process.getuid?.() ?? '?'}); not starting`, {
      error: publicError(err),
      fix: 'docker: docker compose run --rm --user root --cap-add CHOWN --entrypoint chown agent -R node:node /data',
    });
    process.exit(1);
  }
}

const config = configOrExit();
requireWritable(config.stateDir);
const ctx = createContext(config);
const services = createServices(ctx);
const { loops, monitor } = services;
ctx.log('agent', 'starting', {
  ...describeConfig(config),
  keeper: ctx.hub.wallet?.account.address ?? 'read-only',
  deployment: deploymentIdentity(ctx),
});

process.on('unhandledRejection', (reason) => {
  monitor.unhandledRejections += 1;
  ctx.log('agent', 'unhandled promise rejection', { error: publicError(reason) });
});

const modules = config.modules;
let server: Server | null = null;
if (modules.has('http')) {
  server = startHttp(services);
  // Revenue feeds /revenue, /stats, /metrics and the MCP get_revenue tool.
  loops.every('revenue', REVENUE_INTERVAL_MS, () => services.revenue.refresh(), { critical: false });
}
if (modules.has('relayer')) loops.every('relayer', config.pollMs, () => services.relayer.tick());
if (modules.has('liquidator')) loops.every('liquidator', config.pollMs * 2, () => services.liquidator.tick());
if (modules.has('risk')) {
  loops.every(
    'risk',
    RISK_INTERVAL_MS,
    async () => {
      // refresh() keeps the last good report and records the failure; surface it as a failed run.
      await services.risk.refresh();
      const error = services.risk.lastError();
      if (error) throw new Error(error);
    },
    { critical: false },
  );
}
if (modules.has('oracle')) {
  loops.every('oracle', config.oracleWatchMs, () => services.watchdog.check());
  if (services.pusher.status().enabled) loops.every('pyth-pusher', config.oracleWatchMs, () => services.pusher.tick(), { critical: false });
}
loops.every('watch', WATCH_INTERVAL_MS, () => services.watch.tick(), { critical: false });
loops.every('monitor', MONITOR_INTERVAL_MS, () => monitor.tick(), { critical: false });

/**
 * SIGTERM (docker stop) and SIGINT: no new loop runs, wait for the ones in flight (a liquidation waiting for its
 * receipt, a seized-collateral sale, relay deliveries) up to SHUTDOWN_GRACE_MS, then close the HTTP server. Cutting a
 * wait short loses nothing: the liquidator records every transaction before broadcasting it and settles it from
 * chain state after the restart (a mined sale is never sold again), and the relayer checks on-chain whether a
 * message was consumed before it delivers it again. A second signal exits at once.
 */
let stopping = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  ctx.log('agent', 'shutting down', { signal });
  loops.stop();
  const [idle, delivered] = await Promise.all([loops.idle(SHUTDOWN_GRACE_MS), services.relayer.idle(SHUTDOWN_GRACE_MS)]);
  if (!idle || !delivered)
    ctx.log('agent', 'work still in flight at the shutdown deadline; recorded transactions are settled from chain state after the restart');
  if (server) {
    const closing = server;
    await new Promise<void>((resolve) => {
      closing.close(() => resolve());
      closing.closeAllConnections();
    });
  }
  ctx.log('agent', 'stopped');
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => void shutdown(signal));
