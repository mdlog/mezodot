/**
 * Devnet end-to-end: the running agent (relayer + liquidator) must carry a position through the
 * full cross-chain lifecycle without manual help.
 *
 *   1. user locks 1 WETH on the spoke            → agent relays DEPOSIT → hub credits collateral
 *   2. user borrows up to $100 below the 75% LTV limit
 *   3. ETH drops $3,200 → $2,800 (agent mock oracle) → HF < 1
 *   4. agent liquidator repays half the debt via KeeperGateway, seizing WETH with a 7% bonus
 *   5. agent relays the RELEASE                  → keeper receives the WETH on the spoke
 *
 * Prices follow the testnet path: the borrow attaches only the pull updates its risk check needs
 * (a Supra-format proof for ETH, a Pyth payload for MUSD) fetched from the agent's /oracle/update relay.
 *
 * Prereqs: scripts/devnet/start.sh, then the agent with KEEPER_PRIVATE_KEY (anvil #1) and
 * DEVNET_GUARDIAN_KEY. Run: pnpm --filter @mezodot/agent devnet:e2e
 */
import { createPublicClient, createWalletClient, erc20Abi, http, parseEther, parseUnits, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  devnetHub,
  devnetSpoke,
  fetchOracleUpdate,
  getHubDeployment,
  getSpokeDeployment,
  oracleRouterAbi,
  pTokenAbi,
  readOracle,
  readPosition,
  readProtocol,
  riskCheckSymbols,
  spokeGatewayAbi,
  staleSymbols,
  toBytes32,
  vaultManagerAbi,
} from '@mezodot/sdk';

const USER_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'; // anvil #3
const KEEPER: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // anvil #1 (agent keeper)
const TIMEOUT_MS = 90_000;
const AGENT = (process.env.AGENT_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');

const hub = getHubDeployment('devnet-hub');
const spoke = getSpokeDeployment('devnet-spoke');
if (!hub || !spoke) throw new Error('Devnet not deployed — run scripts/devnet/start.sh');

const user = privateKeyToAccount(USER_KEY);
const hubClient = createPublicClient({ chain: devnetHub, transport: http() });
const spokeClient = createPublicClient({ chain: devnetSpoke, transport: http() });
const hubWallet = createWalletClient({ account: user, chain: devnetHub, transport: http() });
const spokeWallet = createWalletClient({ account: user, chain: devnetSpoke, transport: http() });

const started = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s] ${msg}`);

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const setPrice = (prices: Record<string, number>) =>
  fetch(`${AGENT}/oracle/admin/prices`, { method: 'POST', body: JSON.stringify(prices) }).then((r) => r.json());

async function main() {
  await setPrice({ ETH: 3_200 });
  const wethId =
    Number(
      await hubClient.readContract({
        address: hub!.contracts.vaultManager,
        abi: vaultManagerAbi,
        functionName: 'remoteCollateralId',
        args: [10004, toBytes32(spoke!.tokens.WETH)],
      }),
    ) - 1;

  // 1. Lock on the spoke.
  const gateway = spoke!.contracts.spokeGateway;
  await spokeClient.waitForTransactionReceipt({
    hash: await spokeWallet.writeContract({ address: spoke!.tokens.WETH, abi: erc20Abi, functionName: 'approve', args: [gateway, parseEther('1')] }),
  });
  await spokeClient.waitForTransactionReceipt({
    hash: await spokeWallet.writeContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'deposit', args: [spoke!.tokens.WETH, parseEther('1')] }),
  });
  log('user locked 1 WETH on the spoke');
  const balanceBefore = await hubClient.readContract({
    address: hub!.contracts.vaultManager,
    abi: vaultManagerAbi,
    functionName: 'collateralBalance',
    args: [user.address, BigInt(wethId)],
  });
  await until('hub credit', async () => {
    const b = await hubClient.readContract({
      address: hub!.contracts.vaultManager,
      abi: vaultManagerAbi,
      functionName: 'collateralBalance',
      args: [user.address, BigInt(wethId)],
    });
    return b >= balanceBefore + parseEther('1') && b;
  });
  log('agent relayed DEPOSIT → hub credited 1 WETH');

  // 2. Borrow up to just below the limit at $3,200 (75% LTV), whatever the account already owes,
  //    so the script is repeatable on the same account.
  const weth = await hubClient.readContract({
    address: hub!.contracts.vaultManager,
    abi: vaultManagerAbi,
    functionName: 'collateralBalance',
    args: [user.address, BigInt(wethId)],
  });
  const owed = await hubClient.readContract({ address: hub!.contracts.pMUSD, abi: pTokenAbi, functionName: 'borrowBalanceView', args: [user.address] });
  const borrowAmount = (weth * 3_200n * 75n) / 100n - owed - parseUnits('100', 18);
  // Same selection as the web app: the symbols this risk check reads, minus those still fresh on-chain.
  const protocol = await readProtocol(hubClient, hub!);
  const position = await readPosition(hubClient, hub!, protocol, user.address);
  const oracle = await readOracle(hubClient, hub!);
  const needed = staleSymbols(oracle, riskCheckSymbols(protocol, position, 'MUSD'), Math.floor(Date.now() / 1000));
  const update = await fetchOracleUpdate(AGENT, needed);
  if (update.missing.length > 0) throw new Error(`Relay cannot update ${update.missing.join(', ')}`);
  log(`attaching pull updates for ${needed.join(', ') || 'nothing'} (${update.updates.length} payloads)`);
  const fee = await hubClient.readContract({ address: hub!.contracts.oracleRouter, abi: oracleRouterAbi, functionName: 'updateFee', args: [update.updates] });
  await hubClient.waitForTransactionReceipt({
    hash: await hubWallet.writeContract({
      address: hub!.contracts.vaultManager,
      abi: vaultManagerAbi,
      functionName: 'borrow',
      args: [0n, borrowAmount, update.updates],
      value: fee,
    }),
  });
  log(`user borrowed ${(Number(borrowAmount) / 1e18).toFixed(2)} MUSD (debt now ${(Number(owed + borrowAmount) / 1e18).toFixed(2)})`);

  // 3. Crash ETH.
  await setPrice({ ETH: 2_800 });
  log('ETH price set to $2,800 → health factor < 1');

  // 4. Agent liquidates.
  const keeperWethBefore = await spokeClient.readContract({ address: spoke!.tokens.WETH, abi: erc20Abi, functionName: 'balanceOf', args: [KEEPER] });
  const fromBlock = await hubClient.getBlockNumber();
  const liquidation = await until('liquidation', async () => {
    const logs = await hubClient.getContractEvents({
      address: hub!.contracts.vaultManager,
      abi: vaultManagerAbi,
      eventName: 'Liquidated',
      args: { account: user.address },
      fromBlock,
    });
    return logs[0];
  });
  log(
    `agent liquidated: repaid ${Number(liquidation.args.repaid) / 1e18} MUSD, seized ${Number(liquidation.args.seized) / 1e18} WETH (liquidator ${liquidation.args.liquidator})`,
  );

  // 5. Agent relays the RELEASE; keeper receives WETH on the spoke.
  const received = await until('release on spoke', async () => {
    const b = await spokeClient.readContract({ address: spoke!.tokens.WETH, abi: erc20Abi, functionName: 'balanceOf', args: [KEEPER] });
    return b > keeperWethBefore && b - keeperWethBefore;
  });
  log(`agent relayed RELEASE → keeper received ${Number(received) / 1e18} WETH on the spoke`);
  if (received !== liquidation.args.seized) throw new Error('Released amount does not match seized amount');

  const snapshot = await hubClient.readContract({
    address: hub!.contracts.vaultManager,
    abi: vaultManagerAbi,
    functionName: 'getRiskSnapshot',
    args: [user.address],
  });
  log(
    `user health factor after liquidation: ${(Number(snapshot.healthFactor) / 1e18).toFixed(3)} (debt ${(Number(snapshot.debtValue) / 1e18).toFixed(2)} USD)`,
  );
  await setPrice({ ETH: 3_200 });
  console.log(`\n✓ devnet e2e passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch(async (err) => {
  await setPrice({ ETH: 3_200 }).catch(() => {});
  console.error('\n✗ devnet e2e failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
