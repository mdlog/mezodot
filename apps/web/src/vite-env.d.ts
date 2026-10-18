/// <reference types="vite/client" />

/** Validated by src/chain/config.ts; a production build fails on a missing or local service URL. */
interface ImportMetaEnv {
  /** devnet | testnet (default testnet) */
  readonly VITE_MEZODOT_ENV?: string;
  /** Mezodot agent HTTP API (price proofs, relay status, KPIs). Required for production builds. */
  readonly VITE_AGENT_URL?: string;
  /** WalletConnect / Reown project id. Required for production builds. */
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string;
  /** `true` lets a production build use localhost services (local previews of a testnet build). */
  readonly VITE_ALLOW_LOCALHOST?: string;
  /** Wormholescan API base replacing the SDK default. */
  readonly VITE_WORMHOLESCAN_API?: string;
  /** Comma-separated RPC endpoints tried before the public default, e.g. VITE_RPC_URL_MEZO_TESTNET. */
  readonly VITE_RPC_URL_MEZO_TESTNET?: string;
  readonly VITE_RPC_URL_BASE_SEPOLIA?: string;
  readonly VITE_RPC_URL_ETH_SEPOLIA?: string;
  readonly VITE_RPC_URL_DEVNET_HUB?: string;
  readonly VITE_RPC_URL_DEVNET_SPOKE?: string;
}
