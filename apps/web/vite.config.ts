import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { ENVIRONMENTS, NETWORKS } from '../../packages/sdk/src/networks';
import { readWebConfig } from './src/chain/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ command, mode }) => {
  // A bundle is what gets hosted: refuse one that would send visitors to localhost or a placeholder project id.
  if (command === 'build') {
    const { errors } = readWebConfig(loadEnv(mode, root, 'VITE_'), {
      production: true,
      environments: Object.keys(ENVIRONMENTS),
      networks: Object.keys(NETWORKS),
    });
    if (errors.length > 0) {
      throw new Error(`Refusing to build the web app (see apps/web/.env.example):\n  - ${errors.join('\n  - ')}`);
    }
  }
  return {
    plugins: [react()],
    // Some wallet dependencies reference Node's `global` at module scope.
    define: { global: 'globalThis' },
    build: {
      chunkSizeWarningLimit: 2_500,
      rollupOptions: {
        output: {
          // Keep wallet/web3 libraries in their own long-cached chunks.
          manualChunks: {
            wallet: ['@mezo-org/passport', '@rainbow-me/rainbowkit', 'wagmi', '@tanstack/react-query'],
            viem: ['viem'],
          },
        },
      },
    },
    server: { host: '0.0.0.0', port: 3000, strictPort: true },
    preview: { host: '0.0.0.0', port: 3000, strictPort: true },
  };
});
