import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
});
