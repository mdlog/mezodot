/**
 * Post-deploy verification (read-only). Reads packages/sdk/src/deployments/<hub>.json and the spokes of its
 * environment and checks on-chain that every recorded address has code, the Mezodot contracts implement the SDK
 * ABIs, and the hub ⇄ spoke wiring, ownership, markets, collateral, oracle feeds and the Tigris pool are what the
 * deployment says. Exits 1 on any mismatch, 2 on a usage or configuration error.
 *
 *   pnpm verify:deployment [mezo-testnet | devnet-hub] [--brief] [--json]
 *   set -a; source contracts/.env.example; set +a; pnpm verify:deployment mezo-testnet   # plus the documented config
 *
 * --brief prints only failures and warnings; --json prints every finding as JSON.
 * RPCs: RPC_MEZO_TESTNET, RPC_BASE_SEPOLIA, RPC_ETH_SEPOLIA, RPC_DEVNET_HUB, RPC_DEVNET_SPOKE (else the SDK defaults).
 * Optional expectations: EXPECTED_OWNER, EXPECTED_TREASURY, and the deploy variables (LIQUIDATION_FEE_BPS, caps,
 * feeds, max ages, Tigris, SEED_AMOUNT=0); see scripts/lib/verify.ts.
 */
import { asHubDeployment, asSpokeDeployment, environmentOfHub, isNetworkName, publicClient, readDeploymentFile, rpcUrl } from './lib/deployment';
import { expectationsFromEnv, verifyEnvironment, type Finding, type SpokeTarget, type Status } from './lib/verify';

const USAGE = 'usage: pnpm verify:deployment [mezo-testnet | devnet-hub] [--brief] [--json]';
const FLAGS = new Set(['--brief', '--json']);
const MARK: Record<Status, string> = { pass: '✓', fail: '✗', warn: '!', info: '·' };

/** Host only: an RPC URL can carry an API key in its path or query. */
const rpcHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'custom RPC';
  }
};

function print(findings: Finding[], brief: boolean): void {
  let section = '';
  for (const f of findings) {
    if (brief && (f.status === 'pass' || f.status === 'info')) continue;
    if (f.section !== section) {
      section = f.section;
      console.log(`\n${section}`);
    }
    console.log(`  ${MARK[f.status]} ${f.check}${f.detail ? `  ${f.detail}` : ''}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const flags = argv.filter((a) => a.startsWith('--'));
  const args = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.find((f) => !FLAGS.has(f));
  if (unknown || args.length > 1) throw new Error(unknown ? `unknown option ${unknown}\n${USAGE}` : USAGE);
  const network = args[0] ?? 'mezo-testnet';
  if (!isNetworkName(network)) throw new Error(`unknown network "${network}"\n${USAGE}`);

  const env = environmentOfHub(network);
  const hub = { network, deployment: asHubDeployment(network, readDeploymentFile(network)), client: publicClient(network) };
  const spokes: SpokeTarget[] = [];
  const skipped: string[] = [];
  for (const name of env.spokes) {
    const deployment = asSpokeDeployment(name, readDeploymentFile(name));
    if (deployment) spokes.push({ network: name, deployment, client: publicClient(name) });
    else skipped.push(name);
  }
  const expect = expectationsFromEnv();
  const json = flags.includes('--json');

  if (!json) {
    console.log(`Mezodot deployment check: ${network}${spokes.length ? ` with ${spokes.map((s) => s.network).join(', ')}` : ''}`);
    for (const n of [network, ...spokes.map((s) => s.network)]) console.log(`  ${n} via ${rpcHost(rpcUrl(n))}`);
    for (const n of skipped) console.log(`  ${n}: not deployed (contracts: null), skipped`);
  }
  const report = await verifyEnvironment(hub, spokes, expect);
  const [pass, fail, warn, info] = (['pass', 'fail', 'warn', 'info'] as const).map((s) => report.count(s));
  if (json) {
    console.log(JSON.stringify({ network, spokes: spokes.map((s) => s.network), pass, fail, warn, info, findings: report.findings }, null, 2));
  } else {
    print(report.findings, flags.includes('--brief'));
    console.log(`\n${pass} passed, ${fail} failed, ${warn} warnings, ${info} notes`);
  }
  return fail > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    // Configuration errors (unknown network, unreadable JSON); on-chain problems are findings, not exceptions.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
