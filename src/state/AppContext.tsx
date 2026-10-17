import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Activity, AssetSymbol, ChainId, CollateralAsset } from '../data/mock';
import { useHashRoute, type View } from '../hooks/useHashRoute';
import { createInitialState, postCollateral, summarize, validateCollateral, type ActionResult, type DemoState, type Summary } from '../lib/engine';
import { clearState, loadState, saveState } from '../lib/storage';

export type AmountAction = 'supply' | 'withdraw' | 'borrow' | 'repay';
export type ModalState =
  { type: AmountAction; asset: AssetSymbol; amount: string } | { type: 'wallet' } | { type: 'bridge'; chain: ChainId; asset: CollateralAsset; amount: number };

export type Toast = { message: string; tone: 'ok' | 'error' };

export type BridgeFlight = { chain: ChainId; asset: CollateralAsset; amount: number };

/** Lifecycle steps shown on the cross-chain page; stage N means steps 1..N are done. */
export const BRIDGE_STEPS = 4;
const BRIDGE_STEP_MS = 750;
const TOAST_MS = 3_200;

type AppContextValue = {
  state: DemoState;
  summary: Summary;
  view: View;
  go: (view: View) => void;
  connected: boolean;
  connect: () => void;
  modal: ModalState | null;
  openModal: (modal: ModalState) => void;
  openAmount: (type: AmountAction, asset?: AssetSymbol, amount?: string) => void;
  closeModal: () => void;
  selectedActivity: Activity | null;
  setSelectedActivity: (activity: Activity | null) => void;
  toast: Toast | null;
  showToast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: () => void;
  /** Applies a pure engine action; shows its message or error. Returns true on success. */
  run: (action: (state: DemoState) => ActionResult) => boolean;
  bridgeStage: number;
  bridgeFlight: BridgeFlight | null;
  startBridge: (flight: BridgeFlight) => void;
  reset: () => void;
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>(loadState);
  // Mirror of `state` so rapid successive actions (double clicks, timers) never read a stale value.
  const stateRef = useRef(state);
  const [view, navigate] = useHashRoute();
  const [connected, setConnected] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [selectedActivity, setSelectedActivity] = useState<Activity | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [bridgeStage, setBridgeStage] = useState(0);
  const [bridgeFlight, setBridgeFlight] = useState<BridgeFlight | null>(null);

  useEffect(() => saveState(state), [state]);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const commit = useCallback((next: DemoState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'ok') => {
    // Clear the previous timer so an older toast cannot dismiss a newer one early.
    window.clearTimeout(toastTimer.current);
    setToast({ message, tone });
    toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const dismissToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const run = useCallback(
    (action: (s: DemoState) => ActionResult) => {
      const result = action(stateRef.current);
      if (!result.ok) {
        showToast(result.error, 'error');
        return false;
      }
      commit(result.state);
      showToast(result.message);
      return true;
    },
    [commit, showToast],
  );

  const startBridge = useCallback(
    (flight: BridgeFlight) => {
      const error = validateCollateral(stateRef.current, flight.chain, flight.asset, flight.amount);
      if (error) return showToast(error, 'error');
      setModal(null);
      setBridgeFlight(flight);
      setBridgeStage(1);
    },
    [showToast],
  );

  // Advance the simulated Wormhole lifecycle one step at a time; apply state on the final step.
  useEffect(() => {
    if (!bridgeFlight) return;
    if (bridgeStage >= BRIDGE_STEPS) {
      run((s) => postCollateral(s, bridgeFlight.chain, bridgeFlight.asset, bridgeFlight.amount));
      setBridgeFlight(null);
      return;
    }
    const timer = window.setTimeout(() => setBridgeStage((n) => n + 1), BRIDGE_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [bridgeFlight, bridgeStage, run]);

  const go = useCallback(
    (next: View) => {
      navigate(next);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [navigate],
  );

  const openAmount = useCallback((type: AmountAction, asset: AssetSymbol = 'MUSD', amount?: string) => {
    const preset = amount ?? (type === 'supply' && asset === 'MUSD' ? '10000' : type === 'borrow' ? '1000' : '');
    setModal({ type, asset, amount: preset });
  }, []);

  const reset = useCallback(() => {
    clearState();
    commit(createInitialState());
    setBridgeFlight(null);
    setBridgeStage(0);
    setModal(null);
    setSelectedActivity(null);
    showToast('Demo state reset to the initial scenario');
  }, [commit, showToast]);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      summary: summarize(state),
      view,
      go,
      connected,
      connect: () => {
        setConnected(true);
        setModal(null);
        showToast('Demo wallet connected · no wallet provider used');
      },
      modal,
      openModal: setModal,
      openAmount,
      closeModal: () => setModal(null),
      selectedActivity,
      setSelectedActivity,
      toast,
      showToast,
      dismissToast,
      run,
      bridgeStage,
      bridgeFlight,
      startBridge,
      reset,
    }),
    [state, view, go, connected, modal, openAmount, selectedActivity, toast, showToast, dismissToast, run, bridgeStage, bridgeFlight, startBridge, reset],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
