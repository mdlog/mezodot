import { getConfig, getDefaultWallets } from '@mezo-org/passport';
import { injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { fallback, http } from 'wagmi';
import type { Chain } from 'viem';
import { HUB, SPOKES, WALLETCONNECT_PROJECT_ID, rpcUrlsFor } from './env';

const networks = [HUB, ...SPOKES];
const chains = networks.map((n) => n.chain) as [Chain, ...Chain[]];

// Passport's default list has only Bitcoin wallets + WalletConnect; add the common EVM wallets.
const bitcoinGroup = getDefaultWallets('testnet').filter((g) => g.groupName === 'Bitcoin');
const wallets = [...bitcoinGroup, { groupName: 'Ethereum', wallets: [metaMaskWallet, rabbyWallet, injectedWallet, walletConnectWallet] }];

/** VITE_RPC_URL_* endpoints first, the public default last; viem falls through on errors and rate limits. */
const transportFor = (urls: string[]) => (urls.length === 1 ? http(urls[0]) : fallback(urls.map((url) => http(url))));

/**
 * Mezo Passport config: RainbowKit + Bitcoin wallets (Unisat, OKX, Xverse) backed by Mezo smart
 * accounts, plus regular EVM wallets. Passport defaults to Mezo only; we pass the spoke chains too
 * so users can post collateral on Base / Ethereum Sepolia from the same wallet.
 */
export const wagmiConfig = getConfig({
  appName: 'Mezodot Protocol',
  mezoNetwork: 'testnet',
  walletConnectProjectId: WALLETCONNECT_PROJECT_ID,
  chains,
  wallets,
  transports: Object.fromEntries(networks.map((n) => [n.chain.id, transportFor(rpcUrlsFor(n))])),
} as Parameters<typeof getConfig>[0]);
