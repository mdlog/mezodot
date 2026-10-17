import { getConfig, getDefaultWallets } from '@mezo-org/passport';
import { injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { http } from 'wagmi';
import type { Chain } from 'viem';
import { HUB, SPOKES } from './env';

const chains = [HUB.chain, ...SPOKES.map((s) => s.chain)] as [Chain, ...Chain[]];

// Passport's default list has only Bitcoin wallets + WalletConnect; add the common EVM wallets.
const bitcoinGroup = getDefaultWallets('testnet').filter((g) => g.groupName === 'Bitcoin');
const wallets = [...bitcoinGroup, { groupName: 'Ethereum', wallets: [metaMaskWallet, rabbyWallet, injectedWallet, walletConnectWallet] }];

/**
 * Mezo Passport config: RainbowKit + Bitcoin wallets (Unisat, OKX, Xverse) backed by Mezo smart
 * accounts, plus regular EVM wallets. Passport defaults to Mezo only; we pass the spoke chains too
 * so users can post collateral on Base / Ethereum Sepolia from the same wallet.
 */
export const wagmiConfig = getConfig({
  appName: 'Mezodot Protocol',
  mezoNetwork: 'testnet',
  walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? 'mezodot-local-dev',
  chains,
  wallets,
  transports: Object.fromEntries(chains.map((c) => [c.id, http(c.rpcUrls.default.http[0])])),
} as Parameters<typeof getConfig>[0]);
