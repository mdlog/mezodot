/**
 * Runs TroveRouter end to end with a real key: BTC to a Mezo trove to pMUSD, part of the debt repaid from supply, and
 * the trove closed from supply plus a wallet top-up. Prints each transaction, for docs/EVIDENCE.md.
 *
 *   TROVE_PRIVATE_KEY=0x... pnpm exercise:trove
 *
 * Env: TROVE_PRIVATE_KEY (an EOA holding the BTC and at least TROVE_TOPUP MUSD), RPC_URL (default: the network's),
 * TROVE_BTC (0.05), TROVE_DEBT (2100), TROVE_REPAY (50), TROVE_TOPUP (5), TROVE_CLOSE=false to leave the trove open.
 */
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseEther, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  GAS_FLOOR,
  NETWORKS,
  TROVE_STATUS,
  closeBlockedReason,
  closeFunding,
  closeTroveTypedData,
  findTroveHints,
  getHubDeployment,
  maxTroveRepay,
  openBlockers,
  openTroveTypedData,
  pTokenAbi,
  previewOpenTrove,
  readTrove,
  repayTroveTypedData,
  troveContracts,
  troveRouterAbi,
} from '../packages/sdk/src/index';

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const key = process.env.TROVE_PRIVATE_KEY as Hex | undefined;
if (!key) fail('Set TROVE_PRIVATE_KEY');
const account = privateKeyToAccount(key!);
const network = NETWORKS['mezo-testnet'];
const hub = getHubDeployment('mezo-testnet') ?? fail('mezo-testnet is not deployed');
const contracts = troveContracts(hub!) ?? fail('TroveRouter is not recorded in the deployment');
// Generous: Mezo's hint search reads many storage slots, which a local fork fetches one by one.
const transport = http(process.env.RPC_URL ?? network.chain.rpcUrls.default.http[0], { timeout: 180_000 });
const client = createPublicClient({ chain: network.chain, transport });
const wallet = createWalletClient({ account, chain: network.chain, transport });

const btc = parseEther(process.env.TROVE_BTC ?? '0.05');
const debtAmount = parseEther(process.env.TROVE_DEBT ?? '2100');
const repayAmount = parseEther(process.env.TROVE_REPAY ?? '50');
const topUp = parseEther(process.env.TROVE_TOPUP ?? '5');
const shouldClose = process.env.TROVE_CLOSE !== 'false';

const { pMUSD } = hub!.contracts;
const { MUSD } = hub!.tokens;
const domain = { signatures: contracts!.signatures, chainId: network.chain.id };
const deadline = () => BigInt(Math.floor(Date.now() / 1000)) + 1_800n;
const mu = (v: bigint) => Number(formatUnits(v, 18)).toFixed(4);

/** Sends a transaction and stops the run if it reverts, so a later step never acts on a stale assumption. */
async function mined(label: string, hash: Hash): Promise<void> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`${label}: ${hash} (${receipt.status}, gas ${receipt.gasUsed})`);
  if (receipt.status !== 'success') fail(`${label} reverted`);
}

const read = () => readTrove(client, hub!, account.address);
const shareBalance = () => client.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'balanceOf', args: [account.address] });
const musdBalance = () => client.readContract({ address: MUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });

async function approve(token: Address, amount: bigint, label: string): Promise<void> {
  await mined(
    label,
    await wallet.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [contracts!.router, amount], gas: GAS_FLOOR.erc20Approve }),
  );
}

async function open(): Promise<void> {
  const t = await read();
  const input = { btc, debtAmount, price: t.price, borrowingRate: t.borrowingRate, recoveryMode: t.recoveryMode };
  const blockers = openBlockers({ ...input, systemColl: t.systemColl, systemDebt: t.systemDebt, status: t.status, isContract: t.isContract });
  if (blockers.length > 0) fail(blockers.join('\n'));
  const { totalDebt, icr, liquidationPrice } = previewOpenTrove(input);
  console.log(
    `opening: ${mu(btc)} BTC, ${mu(debtAmount)} MUSD, trove debt ${mu(totalDebt)}, ratio ${mu(icr * 100n)}%, liquidation at $${mu(liquidationPrice)}`,
  );
  const { upper, lower } = await findTroveHints(client, hub!, btc, totalDebt);
  const expires = deadline();
  const signature = await account.signTypedData(
    openTroveTypedData(domain, { assetAmount: btc, debtAmount, borrower: account.address, recipient: contracts!.router, nonce: t.nonce, deadline: expires }),
  );
  await mined(
    'open and supply',
    await wallet.writeContract({
      address: contracts!.router,
      abi: troveRouterAbi,
      functionName: 'openAndSupply',
      args: [debtAmount, upper, lower, signature, expires, 0n, false],
      value: btc,
      gas: GAS_FLOOR.troveOpen,
    }),
  );
}

async function repay(): Promise<void> {
  const t = await read();
  if (repayAmount > maxTroveRepay(t.debt)) fail(`Can repay at most ${mu(maxTroveRepay(t.debt))} MUSD`);
  const shares = await client.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'previewWithdraw', args: [repayAmount] });
  const maxShares = (shares * 10_050n) / 10_000n;
  await approve(pMUSD, maxShares, 'approve pMUSD for repay');
  const { upper, lower } = await findTroveHints(client, hub!, t.coll, t.debt - repayAmount);
  const expires = deadline();
  const signature = await account.signTypedData(
    repayTroveTypedData(domain, { amount: repayAmount, borrower: account.address, nonce: t.nonce, deadline: expires }),
  );
  await mined(
    'repay from supply',
    await wallet.writeContract({
      address: contracts!.router,
      abi: troveRouterAbi,
      functionName: 'repayFromSupply',
      args: [repayAmount, upper, lower, signature, expires, maxShares],
      gas: GAS_FLOOR.troveAdjust,
    }),
  );
}

async function close(): Promise<void> {
  const t = await read();
  const blocked = closeBlockedReason(t);
  if (blocked) fail(blocked);
  const shares = await shareBalance();
  const supplyAssets = await client.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'convertToAssets', args: [shares] });
  const wanted = closeFunding({ debt: t.debt + t.debt / 10_000n, supplyAssets, walletMusd: await musdBalance() });
  if (wanted.shortfall > 0n) fail(`Short by ${mu(wanted.shortfall)} MUSD to close`);
  console.log(`closing: burns about ${mu(wanted.needed)} MUSD, ${mu(wanted.fromSupply)} from supply and ${mu(wanted.fromWallet)} from the wallet`);
  await approve(pMUSD, shares, 'approve pMUSD for close');
  if (wanted.fromWallet > 0n) await approve(MUSD, wanted.fromWallet, 'approve MUSD for close');
  const expires = deadline();
  const signature = await account.signTypedData(
    closeTroveTypedData(domain, { borrower: account.address, recipient: account.address, nonce: t.nonce, deadline: expires }),
  );
  await mined(
    'close from supply',
    await wallet.writeContract({
      address: contracts!.router,
      abi: troveRouterAbi,
      functionName: 'closeFromSupply',
      args: [shares, wanted.fromWallet, signature, expires],
      gas: GAS_FLOOR.troveAdjust,
    }),
  );
}

const before = await read();
if (before.status === TROVE_STATUS.ACTIVE) fail('This wallet already has an open trove');
const walletMusd = await musdBalance();
if (shouldClose && walletMusd < topUp) fail(`Needs at least ${mu(topUp)} MUSD in the wallet for the close, has ${mu(walletMusd)}`);

await open();
const opened = await read();
console.log(`trove: status ${opened.status}, ${mu(opened.coll)} BTC, debt ${mu(opened.debt)}, pMUSD ${formatUnits(await shareBalance(), 24)}`);
await repay();
const repaid = await read();
console.log(`trove: debt ${mu(repaid.debt)}, pMUSD ${formatUnits(await shareBalance(), 24)}`);
if (shouldClose) {
  await close();
  const closed = await read();
  console.log(
    `trove: status ${closed.status}, coll ${mu(closed.coll)}, wallet MUSD ${mu(await musdBalance())}, pMUSD ${formatUnits(await shareBalance(), 24)}`,
  );
}
