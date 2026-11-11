import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { ENVIRONMENTS, NETWORKS } from '../../packages/sdk/src/networks';
import { readWebConfig } from './src/chain/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// The dev server serves any file under the workspace root over /@fs/, so it must also refuse the deployer keystore,
// the agent's state and the devnet. Setting `deny` replaces Vite's defaults (the first four).
const fsDeny = ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.secrets/**', '**/.state/**', '**/.devnet/**'];

/**
 * DEV_PUBLIC_HOSTS: comma-separated hostnames that may reach `vite dev` / `vite preview`, e.g. a tunnel to a test
 * box; without it Vite answers localhost and IP addresses only. Host the app with scripts/serve-web.ts, not these.
 */
const publicHosts = (mode: string): string[] =>
  (loadEnv(mode, root, 'DEV_').DEV_PUBLIC_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

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
          // Keep wallet/web3 libraries in their own long-cached chunks. The Node globals the wallet libraries read while
          // they load (Buffer, process) come from src/polyfills.ts, which needs a chunk of its own, listed first: left in
          // the entry chunk it would run after every chunk the entry imports (ES modules evaluate their imports first),
          // and the wallet chunk would throw "process is not defined" before the app could render.
          manualChunks: {
            polyfills: [fileURLToPath(new URL('./src/polyfills.ts', import.meta.url))],
            wallet: ['@mezo-org/passport', '@rainbow-me/rainbowkit', 'wagmi', '@tanstack/react-query'],
            viem: ['viem'],
          },
        },
      },
    },
    server: { host: '0.0.0.0', port: 3000, strictPort: true, allowedHosts: publicHosts(mode), fs: { deny: fsDeny } },
    preview: { host: '0.0.0.0', port: 3000, strictPort: true, allowedHosts: publicHosts(mode) },
  };
});
