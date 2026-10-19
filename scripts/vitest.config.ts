import { fileURLToPath } from 'node:url';

/** node_modules of a workspace package: the repository root installs no viem or vitest of its own. */
const modulesOf = (pkg: string) => fileURLToPath(new URL(`../${pkg}/node_modules/`, import.meta.url));

// Plain object (no `vitest/config` import): this file must load before any alias applies.
export default {
  resolve: {
    alias: {
      viem: `${modulesOf('packages/sdk')}viem`,
      vitest: `${modulesOf('services/agent')}vitest`,
    },
  },
  test: { include: ['test/**/*.test.ts'] },
};
