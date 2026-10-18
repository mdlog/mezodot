import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../smoke-btc.sh', import.meta.url));
const installed = (tool: string): boolean => spawnSync('bash', ['-c', `command -v ${tool}`]).status === 0;

/**
 * Stand-in for Foundry's cast: logs "<subcommand> <--rpc-url value>" for every call that names an RPC, answers
 * eth_chainId only on https://up.example, and fails every eth_call, which ends the smoke test in its preflight.
 */
const STUB_CAST = `#!/usr/bin/env bash
prev=; url=
for a in "$@"; do [ "$prev" = --rpc-url ] && url=$a; prev=$a; done
[ -z "$url" ] || echo "$1 $url" >> "$CAST_LOG"
case "$1" in
  keccak) echo 0x01 ;;
  max-uint) echo 115792089237316195423570985008687907853269984665640564039457584007913129639935 ;;
  wallet) echo 0x00000000000000000000000000000000000000aa ;;
  chain-id) [ "$url" = https://up.example ] && echo 31611 || exit 1 ;;
  *) echo "stub cast: no $1" >&2; exit 1 ;;
esac
`;

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function executable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

describe('smoke-btc.sh', () => {
  // jq reads the deployment JSON for real; bc and curl only run after the preflight, so stubs stand in if missing.
  it.skipIf(!installed('jq'))('takes RPC_<NETWORK> as the agent does: a comma-separated list, first URL that answers', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-btc-'));
    executable(join(dir, 'cast'), STUB_CAST);
    for (const tool of ['bc', 'curl']) if (!installed(tool)) executable(join(dir, tool), '#!/usr/bin/env bash\nexit 1\n');
    writeFileSync(join(dir, 'keystore'), '{}');
    writeFileSync(join(dir, 'password'), 'unused', { mode: 0o600 });
    const log = join(dir, 'rpc.log');

    const run = spawnSync('bash', [SCRIPT, '--keystore', join(dir, 'keystore'), '--password-file', join(dir, 'password')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, CAST_LOG: log, RPC_MEZO_TESTNET: 'https://down.example, https://up.example' },
      encoding: 'utf8',
    });

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe('chain-id https://down.example');
    expect(calls.slice(1).length).toBeGreaterThan(1);
    expect(calls.slice(1).every((c) => c.endsWith(' https://up.example'))).toBe(true);
    expect(run.stdout).toContain('✓ chain id 31611');
    // The stub fails eth_call: the run stops in the preflight, before anything could be sent.
    expect(run.status).toBe(1);
  });

  it.skipIf(!installed('jq'))('stops when no URL of the list answers, without printing them', () => {
    dir = mkdtempSync(join(tmpdir(), 'smoke-btc-'));
    executable(join(dir, 'cast'), STUB_CAST);
    for (const tool of ['bc', 'curl']) if (!installed(tool)) executable(join(dir, tool), '#!/usr/bin/env bash\nexit 1\n');
    writeFileSync(join(dir, 'keystore'), '{}');
    writeFileSync(join(dir, 'password'), 'unused', { mode: 0o600 });

    const run = spawnSync('bash', [SCRIPT, '--keystore', join(dir, 'keystore'), '--password-file', join(dir, 'password')], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        CAST_LOG: join(dir, 'rpc.log'),
        RPC_MEZO_TESTNET: 'https://down.example/SECRETAPIKEY123',
      },
      encoding: 'utf8',
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain('no URL in RPC_MEZO_TESTNET answers');
    expect(run.stdout + run.stderr).not.toContain('SECRETAPIKEY123');
  });
});
