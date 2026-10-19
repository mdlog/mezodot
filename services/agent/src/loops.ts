import type { Logger } from './context';
import { publicError } from './errors';

export type LoopOptions = {
  /** A stalled critical loop makes /health report degraded; others only warn. */
  critical: boolean;
};

export type LoopStats = {
  name: string;
  intervalMs: number;
  critical: boolean;
  runs: number;
  failures: number;
  consecutiveFailures: number;
  /** Start of the run in flight (null when idle). */
  runningSince: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
};

/** Periodic agent loops: never overlapping, failures logged and counted, stoppable for a graceful shutdown. */
export class Loops {
  readonly startedAt: number;
  private readonly stats = new Map<string, LoopStats>();
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  /** Runs `task` now and then every `intervalMs`; a run still in flight makes the next tick a no-op. */
  every(name: string, intervalMs: number, task: () => Promise<unknown>, options: LoopOptions = { critical: true }): void {
    const s: LoopStats = {
      name,
      intervalMs,
      critical: options.critical,
      runs: 0,
      failures: 0,
      consecutiveFailures: 0,
      runningSince: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastDurationMs: null,
    };
    this.stats.set(name, s);
    const run = () => {
      if (s.runningSince !== null || this.stopped) return;
      const started = this.now();
      s.runningSince = started;
      s.runs += 1;
      const p = (async () => {
        try {
          await task();
          s.lastSuccessAt = this.now();
          s.consecutiveFailures = 0;
        } catch (err) {
          s.failures += 1;
          s.consecutiveFailures += 1;
          s.lastFailureAt = this.now();
          s.lastError = publicError(err);
          this.log(name, 'tick failed', { error: s.lastError, consecutiveFailures: s.consecutiveFailures });
        } finally {
          s.lastDurationMs = this.now() - started;
          s.runningSince = null;
        }
      })();
      this.inFlight.add(p);
      void p.finally(() => this.inFlight.delete(p));
    };
    run();
    this.timers.push(setInterval(run, intervalMs));
  }

  snapshot(): LoopStats[] {
    return [...this.stats.values()].map((s) => ({ ...s }));
  }

  /** Stops scheduling new runs; runs in flight continue (see idle). */
  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers.length = 0;
  }

  /** Resolves true once no run is in flight, or false after `timeoutMs`. */
  async idle(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    const done = Promise.allSettled([...this.inFlight]).then(() => true as const);
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    return result;
  }
}
