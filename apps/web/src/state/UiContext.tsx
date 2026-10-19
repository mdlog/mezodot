import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useHashRoute, type View } from '../hooks/useHashRoute';
import type { StepReport } from '../chain/runner';
import { FLIGHTS_KEY, LEGACY_FLIGHTS_KEY, parseFlightStore, serializeFlightStore, type Flight, type FlightStore } from '../data/flights';

export type { Flight } from '../data/flights';

export type AmountModal =
  { type: 'supply' | 'withdraw' | 'borrow' | 'repay'; marketId: number; preset?: string } | { type: 'post' | 'unpost'; collateralId: number; preset?: string };

export type Toast = {
  message: string;
  tone: 'ok' | 'error';
  /** Per-step outcome of a multi-transaction action: which steps landed before one failed. */
  steps?: StepReport[];
  link?: { href: string; label: string };
};

export type ToastOptions = Pick<Toast, 'steps' | 'link'> & {
  /** Stays until dismissed; errors default to sticky, so a reason never disappears unread. */
  sticky?: boolean;
};

const TOAST_MS = 6_000;

const loadFlights = (): FlightStore => {
  try {
    return parseFlightStore(window.localStorage.getItem(FLIGHTS_KEY), window.localStorage.getItem(LEGACY_FLIGHTS_KEY));
  } catch {
    return { flights: [], dismissed: [] };
  }
};

type UiValue = {
  view: View;
  go: (view: View) => void;
  modal: AmountModal | null;
  openModal: (modal: AmountModal) => void;
  closeModal: () => void;
  toast: Toast | null;
  showToast: (message: string, tone?: Toast['tone'], options?: ToastOptions) => void;
  dismissToast: () => void;
  flights: Flight[];
  /** Ids the user dismissed; recovery from on-chain events skips them. */
  dismissedFlights: string[];
  addFlight: (flight: Flight) => void;
  /** Patches a flight; a new `id` (pending → sequence known) replaces the old one. */
  updateFlight: (id: string, patch: Partial<Flight>) => void;
  removeFlight: (id: string) => void;
};

const UiContext = createContext<UiValue | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [view, navigate] = useHashRoute();
  const [modal, setModal] = useState<AmountModal | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [store, setStore] = useState<FlightStore>(loadFlights);

  useEffect(() => {
    try {
      window.localStorage.setItem(FLIGHTS_KEY, serializeFlightStore(store));
    } catch {
      // storage unavailable: tracking still works for this session
    }
  }, [store]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'ok', options: ToastOptions = {}) => {
    window.clearTimeout(timer.current);
    setToast({ message, tone, steps: options.steps, link: options.link });
    if (!(options.sticky ?? tone === 'error')) timer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const go = useCallback(
    (next: View) => {
      navigate(next);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [navigate],
  );

  const addFlight = useCallback(
    (f: Flight) => setStore((s) => ({ ...s, flights: [f, ...s.flights.filter((x) => x.id !== f.id && x.txHash.toLowerCase() !== f.txHash.toLowerCase())] })),
    [],
  );
  const updateFlight = useCallback(
    (id: string, patch: Partial<Flight>) =>
      setStore((s) => {
        const next = patch.id && patch.id !== id ? s.flights.filter((x) => x.id !== patch.id) : s.flights;
        return { ...s, flights: next.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
      }),
    [],
  );
  const removeFlight = useCallback(
    (id: string) => setStore((s) => ({ flights: s.flights.filter((x) => x.id !== id), dismissed: [...s.dismissed.filter((d) => d !== id), id] })),
    [],
  );

  const value = useMemo<UiValue>(
    () => ({
      view,
      go,
      modal,
      openModal: setModal,
      closeModal: () => setModal(null),
      toast,
      showToast,
      dismissToast: () => {
        window.clearTimeout(timer.current);
        setToast(null);
      },
      flights: store.flights,
      dismissedFlights: store.dismissed,
      addFlight,
      updateFlight,
      removeFlight,
    }),
    [view, go, modal, toast, showToast, store, addFlight, updateFlight, removeFlight],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside <UiProvider>');
  return ctx;
}
