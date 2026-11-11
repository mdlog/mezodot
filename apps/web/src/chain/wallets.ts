import { injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';

/**
 * The EVM wallets in the connect dialog. WalletConnect needs a real project id, and so does the MetaMask entry, which
 * falls back to a WalletConnect QR code when the extension is missing. Without one both are left out; an installed
 * MetaMask still shows up through EIP-6963 discovery, like any other extension.
 */
export const ethereumWallets = (walletConnect: boolean) =>
  walletConnect ? [metaMaskWallet, rabbyWallet, injectedWallet, walletConnectWallet] : [rabbyWallet, injectedWallet];
