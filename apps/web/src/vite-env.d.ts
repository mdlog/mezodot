/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** devnet | testnet (default testnet) */
  readonly VITE_MEZODOT_ENV?: string;
  /** Mezodot agent HTTP API (risk report, relay status, KPIs). */
  readonly VITE_AGENT_URL?: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
}
