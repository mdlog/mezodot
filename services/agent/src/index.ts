import { loadConfig } from './config';
import { createContext } from './context';
import { startHttp } from './http';
import { createServices } from './services';

/** Runs `task` every `ms`, never overlapping runs, logging (not throwing) failures. */
function every(ms: number, name: string, task: () => Promise<unknown>, log: (s: string, m: string, e?: Record<string, unknown>) => void) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await task();
    } catch (err) {
      log(name, 'tick failed', { error: err instanceof Error ? err.message.split('\n')[0] : String(err) });
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(run, ms);
}

const config = loadConfig();
const ctx = createContext(config);
const services = createServices(ctx);
ctx.log('agent', 'starting', {
  env: config.env,
  modules: [...config.modules],
  keeper: ctx.hub.wallet?.account.address ?? 'read-only',
  pythPusher: config.pythApiKey ? 'on' : 'off',
});

if (config.modules.has('http')) startHttp(services);
if (config.modules.has('relayer')) every(config.pollMs, 'relayer', () => services.relayer.tick(), ctx.log);
if (config.modules.has('liquidator')) every(config.pollMs * 2, 'liquidator', () => services.liquidator.tick(), ctx.log);
if (config.modules.has('risk')) every(30 * 60_000, 'risk', () => services.risk.refresh(), ctx.log);
if (config.modules.has('oracle')) {
  every(config.oracleWatchMs, 'oracle', () => services.watchdog.check(), ctx.log);
  if (config.pythApiKey) every(config.oracleWatchMs, 'pyth-pusher', () => services.pusher.tick(), ctx.log);
}
