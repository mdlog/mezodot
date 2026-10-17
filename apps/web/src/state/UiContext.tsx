import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Address, Hex } from 'viem';
import type { NetworkName } from '@mezodot/sdk';
import { useHashRoute, type View } from '../hooks/useHashRoute';

export type AmountModal =
  { type: 'supply' | 'withdraw' | 'borrow' | 'repay'; marketId: number; preset?: string } | { type: 'post' | 'unpost'; collateralId: number; preset?: string };

export type Toast = { message: string; tone: 'ok' | 'error' };

/** A cross-chain message the user started, tracked until delivered. */
export type Flight = {
  id: string;
  direction: 'deposit' | 'release';
  source: NetworkName;
  target: NetworkName;
  emitterChain: number;
  emitter: Address;
  sequence: string; // bigint as string for JSON storage
  txHash: Hex;
  label: string;
  createdAt: number;
};

const TOAST_MS = 4_500;
const FLIGHTS_KEY = 'mezodot-flights-v1';

const loadFlights = (): Flight[] => {
  try {
    return JSON.parse(window.localStorage.getItem(FLIGHTS_KEY) ?? '[]') as Flight[];
  } catch {
    return [];
  }
};

type UiValue = {
  view: View;
  go: (view: View) => void;
  modal: AmountModal | null;
  openModal: (modal: AmountModal) => void;
  closeModal: () => void;
  toast: Toast | null;
  showToast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: () => void;
  flights: Flight[];
  addFlight: (flight: Flight) => void;
  removeFlight: (id: string) => void;
};

const UiContext = createContext<UiValue | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [view, navigate] = useHashRoute();
  const [modal, setModal] = useState<AmountModal | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const [flights, setFlights] = useState<Flight[]>(loadFlights);

  useEffect(() => {
    try {
      window.localStorage.setItem(FLIGHTS_KEY, JSON.stringify(flights.slice(0, 20)));
    } catch {
      // storage unavailable: tracking still works for this session
    }
  }, [flights]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'ok') => {
    window.clearTimeout(timer.current);
    setToast({ message, tone });
    timer.current = window.setTimeout(() => setToast(null), TOAST_MS);
  }, []);

  const go = useCallback(
    (next: View) => {
      navigate(next);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    [navigate],
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
      flights,
      addFlight: (f) => setFlights((all) => [f, ...all.filter((x) => x.id !== f.id)]),
      removeFlight: (id) => setFlights((all) => all.filter((x) => x.id !== id)),
    }),
    [view, go, modal, toast, showToast, flights],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside <UiProvider>');
  return ctx;
}
