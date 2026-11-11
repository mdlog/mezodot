import { describe, expect, it } from 'vitest';
import { injectedWallet, metaMaskWallet, rabbyWallet, walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { ethereumWallets } from './wallets';

describe('EVM wallets offered in the connect dialog', () => {
  it('lists WalletConnect, and MetaMask (which falls back to a WalletConnect QR code), only with a real project id', () => {
    expect(ethereumWallets(true)).toEqual([metaMaskWallet, rabbyWallet, injectedWallet, walletConnectWallet]);
    // Without one, an installed MetaMask still shows up through EIP-6963 discovery, like any other extension.
    expect(ethereumWallets(false)).toEqual([rabbyWallet, injectedWallet]);
  });
});
