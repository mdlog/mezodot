/**
 * Protocol revenue report and collection plan (read-only, docs/REVENUE.md). Reads the hub in
 * packages/sdk/src/deployments/<network>.json at its latest block: pool reserves (stored, accrued, withdrawable now),
 * lifetime flash fees, reserve withdrawals and bad debt absorbed (events since the deployment's start block), and the
 * treasury's liquidation fees held as collateral in VaultManager custody, then prints the cast commands that would
 * collect what is collectable now. Nothing is sent.
 *
 *   pnpm revenue:report [mezo-testnet | devnet-hub] [--json] [--no-events] [--from-block <n>] [--to <address>]
 *
 * --to: recipient of the withdrawals (default: the treasury). The commands expect RPC and KEYSTORE shell variables;
 * reserves are withdrawn by the owner, custody balances by the treasury. RPC: RPC_MEZO_TESTNET / RPC_DEVNET_HUB, else
 * the SDK default. Exits 1 when the chain cannot be read, 2 on a usage or configuration error.
 */
import { formatUnits, isAddress, type Address } from 'viem';
import { asHubDeployment, asSpokeDeployment, environmentOfHub, errorLine, isNetworkName, publicClient, readDeploymentFile, rpcUrl } from './lib/deployment';
import { collectionPlan, readRevenue, type CollectionPlan, type RevenueReport } from './lib/revenue';

const USAGE = 'usage: pnpm revenue:report [mezo-testnet | devnet-hub] [--json] [--no-events] [--from-block <n>] [--to <address>]';

class UsageError extends Error {}

type Args = { network: string; json: boolean; events: boolean; fromBlock?: bigint; to?: Address };

function parseArgs(argv: string[]): Args {
  const args: Args = { network: 'mezo-testnet', json: false, events: true };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--no-events') args.events = false;
    else if (a === '--from-block') {
      const v = argv[++i];
      if (!v || !/^\d+$/.test(v)) throw new UsageError(`--from-block needs a block number\n${USAGE}`);
      args.fromBlock = BigInt(v);
    } else if (a === '--to') {
      const v = argv[++i];
      if (!v || !isAddress(v, { strict: false })) throw new UsageError(`--to needs an address\n${USAGE}`);
      args.to = v as Address;
    } else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}\n${USAGE}`);
    else positional.push(a);
  }
  if (positional.length > 1) throw new UsageError(USAGE);
  if (positional[0]) args.network = positional[0];
  return args;
}

/** Host only: an RPC URL can carry an API key in its path or query. */
const rpcHost = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return 'custom RPC';
  }
};
const usd = (v: number | null): string =>
  v === null ? 'no price' : v > 0 && v < 0.01 ? '<$0.01' : `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (wad: bigint): string => `${formatUnits(wad * 100n, 18)}%`;
const sum = (values: (number | null)[]): number => values.reduce<number>((s, v) => s + (v ?? 0), 0);

function print(r: RevenueReport, plan: CollectionPlan, host: string): void {
  const since = r.scanned ? `since block ${r.scanned.fromBlock}` : null;
  console.log(`Mezodot revenue on ${r.network} at block ${r.blockNumber} (${new Date(Number(r.timestamp) * 1000).toISOString()}) via ${host}`);
  const treasury = r.treasury.toLowerCase() === r.owner.toLowerCase() ? `${r.treasury} (the owner)` : r.treasury;
  console.log(`  owner ${r.owner}, treasury ${treasury}, liquidation fee ${r.liquidationFeeBps / 100}% of each bonus`);

  console.log('\nPool reserves (owner: withdrawReserves)');
  for (const p of r.pools) {
    const amount = (v: bigint) => formatUnits(v, p.decimals);
    console.log(`  ${p.label}  reserve factor ${pct(p.reserveFactor)}`);
    console.log(
      `    reserves ${amount(p.accruedReserves)} ${p.asset} accrued (${amount(p.totalReserves)} stored, ${usd(p.price === null ? null : Number(amount(p.accruedReserves)) * p.price)}); ` +
        `idle cash ${amount(p.cash)}; withdrawable now ${amount(p.withdrawable)} ${p.asset}`,
    );
    if (p.events) {
      console.log(
        `    ${since}: flash fees ${amount(p.events.flashFees)}, withdrawn ${amount(p.events.reservesWithdrawn)}, bad debt absorbed ${amount(p.events.badDebtAbsorbed)}`,
      );
    }
  }

  console.log('\nTreasury collateral in VaultManager custody (treasury: withdrawCollateral / withdrawRemote)');
  const shown = r.holdings.filter((h) => h.balance > 0n || (h.feesTaken ?? 0n) > 0n);
  if (shown.length === 0) console.log(`  none${since ? ` (no liquidation fee taken ${since})` : ''}`);
  for (const h of shown) {
    const held =
      h.kind === 'share'
        ? `${formatUnits(h.balance, h.balanceDecimals)} shares = ${formatUnits(h.assets, h.assetDecimals)} ${h.asset}`
        : `${formatUnits(h.balance, h.balanceDecimals)} ${h.asset}`;
    const fees = h.feesTaken === null ? '' : `; fees taken ${since}: ${formatUnits(h.feesTaken, h.balanceDecimals)}`;
    console.log(`  #${h.id} ${h.label} (${h.kind})  ${held} (${usd(h.usd)})${fees}`);
  }
  if (r.treasuryDebtValue > 0n) console.log(`  ! the treasury account has $${formatUnits(r.treasuryDebtValue, 18)} of debt`);

  const reserves = sum(r.pools.map((p) => (p.price === null ? null : Number(formatUnits(p.accruedReserves, p.decimals)) * p.price)));
  const withdrawable = sum(r.pools.map((p) => (p.price === null ? null : Number(formatUnits(p.withdrawable, p.decimals)) * p.price)));
  console.log(`\nTotals: reserves ${usd(reserves)} (withdrawable now ${usd(withdrawable)}), treasury collateral ${usd(sum(r.holdings.map((h) => h.usd)))}`);

  if (plan.steps.length === 0) {
    console.log('\nCollection plan: nothing to collect');
  } else {
    console.log('\nCollection plan (nothing was sent; set RPC and KEYSTORE, review every line, run as the signer named):');
    for (const s of plan.steps) console.log(`  # ${s.signer}: ${s.what}\n  ${s.command}`);
  }
  for (const n of plan.notes) console.log(`  note: ${n}`);
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!isNetworkName(args.network)) throw new UsageError(`unknown network "${args.network}"\n${USAGE}`);
  const env = environmentOfHub(args.network);
  const deployment = asHubDeployment(args.network, readDeploymentFile(args.network));
  const spokes = env.spokes.flatMap((name) => {
    const d = asSpokeDeployment(name, readDeploymentFile(name));
    return d ? [{ network: name, deployment: d }] : [];
  });
  let report: RevenueReport;
  try {
    report = await readRevenue(
      { network: args.network, deployment, client: publicClient(args.network), spokes },
      { events: args.events, fromBlock: args.fromBlock },
    );
  } catch (err) {
    console.error(`cannot read ${args.network}: ${errorLine(err)}`);
    return 1;
  }
  const plan = collectionPlan(report, args.to);
  if (args.json) console.log(JSON.stringify({ report, plan }, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
  else print(report, plan, rpcHost(rpcUrl(args.network)));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
