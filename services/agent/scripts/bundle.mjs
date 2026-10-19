// Bundles the agent and the stdio MCP server into self-contained ESM files (dependencies, ABIs and the deployment
// JSON included), so the production image needs neither node_modules nor tsx:
//   node scripts/bundle.mjs [--outdir dist]   →   dist/agent.mjs, dist/mcp-stdio.mjs (+ source maps)
// esbuild is the one tsx already ships with (no extra dependency).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { outdir: { type: 'string', default: 'dist' } } });
const fromAgent = createRequire(join(root, 'package.json'));
const esbuild = createRequire(fromAgent.resolve('tsx/package.json'))('esbuild');

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: { agent: 'src/index.ts', 'mcp-stdio': 'src/mcp/stdio.ts' },
  outdir: values.outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  // Optional native speed-ups of `ws` (pulled in by viem); `ws` falls back to JavaScript without them.
  external: ['bufferutil', 'utf-8-validate'],
  // Bundled CommonJS dependencies call require(); ESM output has none of its own.
  banner: { js: "import { createRequire as __agentRequire } from 'node:module'; const require = __agentRequire(import.meta.url);" },
  metafile: true,
  logLevel: 'warning',
});
for (const [file, out] of Object.entries(result.metafile.outputs)) {
  if (!file.endsWith('.map')) console.log(`${file}  ${(out.bytes / 1024).toFixed(0)} KiB`);
}
