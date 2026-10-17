import { STATE_VERSION, createInitialState, type DemoState } from './engine';

const KEY = 'mezodot-demo-state';

/** Loads persisted demo state; falls back to a fresh state when missing, outdated or unreadable. */
export function loadState(): DemoState {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw) as Partial<DemoState>;
    if (parsed.version !== STATE_VERSION || !parsed.account || !parsed.rates || !Array.isArray(parsed.activities)) return createInitialState();
    return parsed as DemoState;
  } catch {
    return createInitialState();
  }
}

export function saveState(state: DemoState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage may be blocked (private mode, quota); the demo still works in memory.
  }
}

export function clearState(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
