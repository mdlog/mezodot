// The demo wallet: a fresh key the video signs with (never the owner's), its funding from the deployer keystore, the
// one-time approvals done off camera, and the signer behind the EIP-1193 provider injected into recorded pages. The
// key stays in this Node process; the page only asks it to send a transaction or sign a typed message.
//
//   node video/wallet.mjs status     address, balances, approvals
//   node video/wallet.mjs fund       top up from the deployer keystore (cast asks for its password)
//   node video/wallet.mjs prepare    what the BTC long and the trove close need, done off camera
//
// Keys live outside the repository (docs/DEPLOY.md, key storage): VIDEO_DEMO_WALLET (~/.mezodot/wallets/video-demo.json),
// MEZODOT_KEYSTORE (~/.mezodot/keystores/deployer), and MEZODOT_KEYSTORE_PASSWORD_FILE only for a throwaway keystore.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PLAN } from './plan.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const VIEM = new URL('../packages/sdk/node_modules/viem/_esm/', import.meta.url);
const viem = await import(new URL('index.js', VIEM).href);
const { generatePrivateKey, privateKeyToAccount } = await import(new URL('accounts/index.js', VIEM).href);

const deployment = (name) => JSON.parse(readFileSync(`${ROOT}packages/sdk/src/deployments/${name}.json`, 'utf8'));
export const HUB = deployment('mezo-testnet');
export const BASE = deployment('base-sepolia');

export const RPC = { 31611: 'https://rpc.test.mezo.org', 84532: 'https://sepolia.base.org', 11155111: 'https://ethereum-sepolia-rpc.publicnode.com' };
const chain = (id, name, symbol) =>
  viem.defineChain({ id, name, nativeCurrency: { name: symbol, symbol, decimals: 18 }, rpcUrls: { default: { http: [RPC[id]] } } });
const CHAINS = { 31611: chain(31611, 'Mezo Testnet', 'BTC'), 84532: chain(84532, 'Base Sepolia', 'ETH'), 11155111: chain(11155111, 'Sepolia', 'ETH') };

export const publicClient = (id) => viem.createPublicClient({ chain: CHAINS[id], transport: viem.http(RPC[id]) });
const walletClient = (id, account) => viem.createWalletClient({ account, chain: CHAINS[id], transport: viem.http(RPC[id]) });

// Anything inside the repository is copied by backups, sync tools and editor indexers, and a dev server can serve it.
const KEY = process.env.VIDEO_DEMO_WALLET || join(homedir(), '.mezodot', 'wallets', 'video-demo.json');
const LEGACY_KEY = new URL('./.secrets/demo.json', import.meta.url).pathname;
const KEYSTORE = process.env.MEZODOT_KEYSTORE || join(homedir(), '.mezodot', 'keystores', 'deployer');

/** The demo account, created on first use. */
export function demoAccount() {
  if (!existsSync(KEY)) {
    // A new key would be an unfunded wallet the stored session does not know: move the old one instead.
    if (existsSync(LEGACY_KEY))
      throw new Error(`The demo key is still inside the repository; move it out first:\n  mkdir -p -m 700 ${dirname(KEY)} && mv ${LEGACY_KEY} ${KEY}`);
    mkdirSync(dirname(KEY), { recursive: true, mode: 0o700 });
    const privateKey = generatePrivateKey();
    writeFileSync(KEY, JSON.stringify({ address: privateKeyToAccount(privateKey).address, privateKey }), { mode: 0o600, flag: 'wx' });
  }
  return privateKeyToAccount(JSON.parse(readFileSync(KEY, 'utf8')).privateKey);
}

const erc20 = viem.parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function deposit() payable',
]);
const vault = viem.parseAbi(['function isOperator(address,address) view returns (bool)', 'function setOperator(address,bool)']);

/** Everything the plan needs, read live. */
export async function status(address) {
  const hub = publicClient(31611);
  const base = publicClient(84532);
  const { tokens, contracts } = HUB;
  const read = (client, token, fn, args) => client.readContract({ address: token, abi: erc20, functionName: fn, args });
  const isOp = (op) => hub.readContract({ address: contracts.vaultManager, abi: vault, functionName: 'isOperator', args: [address, op] });
  const [btc, musd, ethBase, wethBase, loopOp, longOp, aSupply, aLoop, aLong, aLock] = await Promise.all([
    hub.getBalance({ address }),
    read(hub, tokens.MUSD, 'balanceOf', [address]),
    base.getBalance({ address }),
    read(base, BASE.tokens.WETH, 'balanceOf', [address]),
    isOp(contracts.leverageManager),
    isOp(contracts.swapLeverageManager),
    read(hub, tokens.MUSD, 'allowance', [address, contracts.pMUSD]),
    read(hub, tokens.MUSD, 'allowance', [address, contracts.leverageManager]),
    read(hub, tokens.BTC, 'allowance', [address, contracts.swapLeverageManager]),
    read(base, BASE.tokens.WETH, 'allowance', [address, BASE.contracts.spokeGateway]),
  ]);
  return { btc, musd, ethBase, wethBase, loopOp, longOp, aSupply, aLoop, aLong, aLock };
}

/**
 * Sends from the deployer keystore with cast; the key is decrypted by cast, never read here. cast asks for the password
 * on the terminal unless MEZODOT_KEYSTORE_PASSWORD_FILE names a file (never keep one for the owner key).
 */
function castSend(rpc, args) {
  if (!existsSync(KEYSTORE)) throw new Error(`No deployer keystore at ${KEYSTORE} (set MEZODOT_KEYSTORE)`);
  const passwordFile = process.env.MEZODOT_KEYSTORE_PASSWORD_FILE;
  const r = spawnSync('cast', ['send', '--rpc-url', rpc, '--keystore', KEYSTORE, ...(passwordFile ? ['--password-file', passwordFile] : []), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (r.status !== 0) throw new Error(`cast send failed: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  return r.stdout.match(/transactionHash\s+(0x[0-9a-fA-F]{64})/)?.[1];
}

async function fund(address) {
  const s = await status(address);
  const want = { btc: viem.parseEther(PLAN.fund.btc), musd: viem.parseEther(PLAN.fund.musd) };
  if (s.btc < want.btc) console.log('BTC  ', castSend(RPC[31611], [address, '--value', (want.btc - s.btc).toString()]));
  if (s.musd < want.musd) console.log('MUSD ', castSend(RPC[31611], [HUB.tokens.MUSD, 'transfer(address,uint256)', address, (want.musd - s.musd).toString()]));
}

async function prepare(account) {
  const address = account.address;
  const s = await status(address);
  const { tokens, contracts } = HUB;
  const sends = [];
  const hub = walletClient(31611, account);
  const write = async (client, label, req) => {
    const hash = await client.writeContract(req);
    const receipt = await publicClient(client.chain.id).waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    sends.push(`${label}: ${hash}`);
  };
  const long = viem.parseEther(PLAN.btcLong.btc);
  if (!s.longOp)
    await write(hub, 'authorise SwapLeverageManager', {
      address: contracts.vaultManager,
      abi: vault,
      functionName: 'setOperator',
      args: [contracts.swapLeverageManager, true],
    });
  if (s.aLong < long)
    await write(hub, 'approve BTC → SwapLeverageManager', {
      address: tokens.BTC,
      abi: erc20,
      functionName: 'approve',
      args: [contracts.swapLeverageManager, long],
    });
  // Closing a trove needs two approvals first. Done here so the close beat films one transaction, not three.
  for (const [symbol, token, amount] of [
    ['pMUSD', contracts.pMUSD, viem.parseUnits('2100', 24)],
    ['MUSD', tokens.MUSD, viem.parseEther('10')],
  ]) {
    const allowance = await publicClient(31611).readContract({ address: token, abi: erc20, functionName: 'allowance', args: [address, contracts.troveRouter] });
    if (allowance < amount)
      await write(hub, `approve ${symbol} → TroveRouter`, { address: token, abi: erc20, functionName: 'approve', args: [contracts.troveRouter, amount] });
  }
  console.log(sends.length ? sends.join('\n') : 'already prepared');
}

/** Lets a recorded context send transactions from the demo account; every hash is pushed onto `log`. */
export async function exposeSigner(context, account, log) {
  await context.exposeBinding('__demoSend', async (_source, chainId, tx) => {
    const hash = await walletClient(chainId, account).sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ? BigInt(tx.value) : 0n,
      ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
    });
    log.push({ chainId, hash, to: tx.to, at: Date.now() });
    return hash;
  });
  // Mezo's trove contracts take an EIP-712 signature checked with plain ECDSA, which this EOA can give.
  await context.exposeBinding('__demoSignTyped', async (_source, typedJson) => {
    const { domain, types, primaryType, message } = JSON.parse(typedJson);
    return account.signTypedData({ domain: { ...domain, chainId: Number(domain.chainId) }, types, primaryType, message });
  });
}

/** EIP-1193 provider (announced over EIP-6963 as "Demo Wallet") that reads from public RPCs and sends through Node. */
export const walletInit = (address) => `(() => {
  const RPC = ${JSON.stringify(RPC)};
  const ACCOUNT = '${address}';
  let chainId = 31611;
  const listeners = {};
  const emit = (e, d) => (listeners[e] || []).forEach((f) => { try { f(d); } catch {} });
  async function rpc(method, params) {
    const r = await fetch(RPC[chainId], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  }
  const provider = {
    request: async ({ method, params = [] }) => {
      switch (method) {
        case 'eth_requestAccounts': case 'eth_accounts': return [ACCOUNT];
        case 'eth_chainId': return '0x' + chainId.toString(16);
        case 'net_version': return String(chainId);
        case 'wallet_switchEthereumChain': {
          const id = parseInt(params[0].chainId, 16);
          if (!RPC[id]) throw Object.assign(new Error('Unrecognized chain ' + id), { code: 4902 });
          chainId = id; emit('chainChanged', '0x' + id.toString(16)); return null;
        }
        case 'wallet_addEthereumChain': return null;
        case 'wallet_requestPermissions': case 'wallet_getPermissions': return [{ parentCapability: 'eth_accounts' }];
        case 'eth_sendTransaction': return window.__demoSend(chainId, params[0]);
        case 'eth_signTypedData_v4': return window.__demoSignTyped(params[1]);
        case 'personal_sign': case 'eth_sign':
          throw Object.assign(new Error('The demo wallet does not sign plain messages'), { code: 4200 });
        default: return rpc(method, params);
      }
    },
    on: (e, f) => { (listeners[e] ||= []).push(f); return provider; },
    removeListener: (e, f) => { listeners[e] = (listeners[e] || []).filter((x) => x !== f); return provider; },
  };
  window.ethereum = provider;
  const icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#4338CA"/><circle cx="23" cy="9" r="3" fill="#C9F27C"/></svg>');
  const info = { uuid: '0d6e3d1c-5f2a-4c3b-9a43-6d0b0a5f0001', name: 'Demo Wallet', icon, rdns: 'dev.mezodot.demo' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const account = demoAccount();
  const cmd = process.argv[2] ?? 'status';
  if (cmd === 'fund') await fund(account.address);
  if (cmd === 'prepare') await prepare(account);
  const s = await status(account.address);
  const f = (v) => viem.formatEther(v);
  console.log(`demo wallet ${account.address}`);
  console.log(`  Mezo: ${f(s.btc)} BTC, ${f(s.musd)} MUSD | Base Sepolia: ${f(s.ethBase)} ETH, ${f(s.wethBase)} WETH`);
  console.log(`  operators: LeverageManager ${s.loopOp}, SwapLeverageManager ${s.longOp}`);
  console.log(
    `  allowances: MUSD→pMUSD ${f(s.aSupply)}, MUSD→LeverageManager ${f(s.aLoop)}, BTC→SwapLeverageManager ${f(s.aLong)}, WETH→SpokeGateway ${f(s.aLock)}`,
  );
}
