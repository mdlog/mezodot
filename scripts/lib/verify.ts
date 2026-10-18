import {
  erc20Abi,
  formatUnits,
  isAddress,
  toFunctionSelector,
  toFunctionSignature,
  zeroAddress,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  NETWORKS,
  PRICE_KEYS,
  PRICE_SYMBOLS,
  SOURCE_TAG,
  SUPRA_PAIRS,
  keeperGatewayAbi,
  leverageManagerAbi,
  oracleRouterAbi,
  pTokenAbi,
  spokeGatewayAbi,
  swapLeverageManagerAbi,
  tigrisPoolAbi,
  tigrisPoolFactoryAbi,
  tigrisRouterAbi,
  toBytes32,
  vaultManagerAbi,
  wormholeAbi,
  wormholeAdapterAbi,
  type HubDeployment,
  type NetworkName,
  type PriceSymbol,
  type SpokeDeployment,
} from '../../packages/sdk/src/index';
import { errorLine } from './deployment';

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

/** fail: the deployment does not match the code or the expected configuration. warn: works, but needs attention. */
export type Status = 'pass' | 'fail' | 'warn' | 'info';
export type Finding = { status: Status; section: string; check: string; detail: string };

/** Addresses and hex compare case-insensitively, numbers and bigints by value. */
const same = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if ((typeof a === 'bigint' || typeof a === 'number') && (typeof b === 'bigint' || typeof b === 'number')) return BigInt(a) === BigInt(b);
  return a === b;
};
const show = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'bigint' ? v.toString() : JSON.stringify(v));

export class Report {
  readonly findings: Finding[] = [];
  private section = '';

  begin(section: string): void {
    this.section = section;
  }

  add(status: Status, check: string, detail = ''): void {
    this.findings.push({ status, section: this.section, check, detail });
  }

  pass(check: string, detail = ''): void {
    this.add('pass', check, detail);
  }

  fail(check: string, detail: string): void {
    this.add('fail', check, detail);
  }

  warn(check: string, detail: string): void {
    this.add('warn', check, detail);
  }

  info(check: string, detail: string): void {
    this.add('info', check, detail);
  }

  /** pass when `actual` equals `expected`, otherwise fail with both values. */
  equal(check: string, actual: unknown, expected: unknown): boolean {
    if (same(actual, expected)) {
      this.pass(check, show(actual));
      return true;
    }
    this.fail(check, `expected ${show(expected)}, got ${show(actual)}`);
    return false;
  }

  /** pass or fail on a condition. */
  that(check: string, ok: boolean, passDetail: string, failDetail: string): boolean {
    if (ok) this.pass(check, passDetail);
    else this.fail(check, failDetail);
    return ok;
  }

  count(status: Status): number {
    return this.findings.filter((f) => f.status === status).length;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Bytecode ⇄ ABI
// ---------------------------------------------------------------------------------------------------------------

/**
 * The PUSHn instruction (opcode and immediate, hex) with which a Solidity dispatcher compares calldata against
 * `selector`. The compiler drops leading zero bytes (0x00fdd58e is pushed as PUSH3 0xfdd58e).
 */
export function selectorPush(selector: Hex): string {
  const bytes = selector
    .slice(2)
    .toLowerCase()
    .replace(/^(?:00)+/, '');
  return (0x5f + bytes.length / 2).toString(16) + bytes;
}

const containsAligned = (code: string, needle: string): boolean => {
  for (let i = code.indexOf(needle); i !== -1; i = code.indexOf(needle, i + 1)) if (i % 2 === 0) return true;
  return false;
};

/**
 * Functions of `abi` whose selector never appears in `code`'s dispatcher: the deployed contract does not implement
 * them, so the ABI (the SDK's) and the deployment come from different contract versions. A stray match elsewhere
 * in the bytecode can only hide a missing function, never report a present one as missing.
 */
export function missingFunctions(code: Hex, abi: Abi): string[] {
  const hex = code.slice(2).toLowerCase();
  return abi
    .filter((item): item is AbiFunction => item.type === 'function')
    .filter((f) => !containsAligned(hex, selectorPush(toFunctionSelector(f))))
    .map((f) => toFunctionSignature(f));
}

// ---------------------------------------------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------------------------------------------

export type FeedPolicy = {
  /** Pyth (primary) leg max age, s. */
  maxAge?: number;
  maxConfBps?: number;
  /** Supra pair of the secondary leg; null when the loaded deploy environment configures none. */
  supraPair?: number | null;
  supraMaxAge?: number;
  divergenceBps?: number;
};

export const CAP_VARS = [
  'MUSD_SUPPLY_CAP',
  'MUSD_BORROW_CAP',
  'MEZO_SUPPLY_CAP',
  'MEZO_BORROW_CAP',
  'MEZO_COLLATERAL_CAP',
  'BTC_COLLATERAL_CAP',
  'WETH_CAP',
  'USDC_CAP',
] as const;
export type CapVar = (typeof CAP_VARS)[number];

export type Expectations = {
  /** Owner of every Ownable contract (EXPECTED_OWNER); default: whoever owns the VaultManager. */
  owner?: Address;
  /** VaultManager.treasury() (EXPECTED_TREASURY); default: the owner, as the deploy scripts set it. */
  treasury?: Address;
  liquidationFeeBps?: number;
  /** TIGRIS_STABLE: which Tigris MUSD/BTC curve the leverage desk must use (default volatile). */
  tigrisStable: boolean;
  /** SEED_AMOUNT=0 skips the seed-deposit check. */
  seeded: boolean;
  /** Deploy inputs the deployment JSON must match, per network: JSON path (e.g. "tokens.MUSD") → value. */
  inputs: Partial<Record<NetworkName, Record<string, string>>>;
  feeds: Partial<Record<PriceSymbol, FeedPolicy>>;
  /** Caps in token wei, as the deploy scripts read them. */
  caps: Partial<Record<CapVar, bigint>>;
};

/** Hub inputs of DeployHub (contracts/.env.example names), keyed by where they land in the deployment JSON. */
const HUB_INPUTS: Record<string, string> = {
  'tokens.MUSD': 'MUSD',
  'tokens.MEZO': 'MEZO',
  'tokens.BTC': 'BTC',
  'contracts.pyth': 'PYTH',
  'contracts.supraPull': 'SUPRA_PULL',
  'contracts.tigrisRouter': 'TIGRIS_ROUTER',
  'contracts.tigrisFactory': 'TIGRIS_FACTORY',
  ...Object.fromEntries(PRICE_SYMBOLS.map((s) => [`priceFeeds.${s}`, `${s}_FEED`])),
};

/** Per-network names in contracts/.env.example; DEPLOY.md hands them to the scripts as WORMHOLE, WETH and USDC. */
const NETWORK_INPUTS: Partial<Record<NetworkName, Record<string, string>>> = {
  'mezo-testnet': { ...HUB_INPUTS, 'contracts.wormhole': 'MEZO_WORMHOLE' },
  'base-sepolia': { 'contracts.wormhole': 'BASE_WORMHOLE', 'tokens.WETH': 'BASE_WETH', 'tokens.USDC': 'BASE_USDC' },
  'eth-sepolia': { 'contracts.wormhole': 'ETH_WORMHOLE', 'tokens.WETH': 'ETH_WETH', 'tokens.USDC': 'ETH_USDC' },
};

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => (env[name] === undefined || env[name] === '' ? undefined : env[name]);

function intVar(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const v = envValue(env, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer, got "${v}"`);
  return Number(v);
}

function weiVar(env: NodeJS.ProcessEnv, name: string): bigint | undefined {
  const v = envValue(env, name);
  if (v === undefined) return undefined;
  if (!/^(\d+|0x[0-9a-fA-F]+)$/.test(v)) throw new Error(`${name} must be an integer amount in token wei, got "${v}"`);
  return BigInt(v);
}

function addressVar(env: NodeJS.ProcessEnv, name: string): Address | undefined {
  const v = envValue(env, name);
  if (v === undefined) return undefined;
  if (!isAddress(v, { strict: false })) throw new Error(`${name} must be an address, got "${v}"`);
  return v as Address;
}

/**
 * Expectations from the environment. Each value is compared only when its variable is set, so a bare run checks
 * the wiring and a run after `set -a; source contracts/.env.example; set +a` also checks the documented testnet
 * configuration. A set `PYTH` marks a loaded deploy environment: Supra legs it does not configure must be absent.
 */
export function expectationsFromEnv(env: NodeJS.ProcessEnv = process.env): Expectations {
  const deployEnv = envValue(env, 'PYTH') !== undefined;
  const supra = envValue(env, 'SUPRA_PULL') !== undefined;
  const feeds: Expectations['feeds'] = {};
  for (const s of PRICE_SYMBOLS) {
    const pair = supra ? intVar(env, `${s}_SUPRA_PAIR`) : undefined;
    feeds[s] = {
      maxAge: intVar(env, `${s}_MAX_AGE`),
      maxConfBps: intVar(env, `${s}_MAX_CONF_BPS`),
      supraPair: pair ?? (deployEnv ? null : undefined),
      supraMaxAge: intVar(env, 'SUPRA_MAX_AGE'),
      divergenceBps: intVar(env, 'DIVERGENCE_BPS'),
    };
  }
  const inputs: Expectations['inputs'] = {};
  for (const [network, vars] of Object.entries(NETWORK_INPUTS) as [NetworkName, Record<string, string>][]) {
    const values = Object.entries(vars).flatMap(([path, name]) => {
      const v = envValue(env, name);
      return v === undefined ? [] : [[path, v] as const];
    });
    if (values.length > 0) inputs[network] = Object.fromEntries(values);
  }
  const caps: Expectations['caps'] = {};
  for (const name of CAP_VARS) {
    const v = weiVar(env, name);
    if (v !== undefined) caps[name] = v;
  }
  const stable = envValue(env, 'TIGRIS_STABLE');
  if (stable !== undefined && stable !== 'true' && stable !== 'false') throw new Error(`TIGRIS_STABLE must be true or false, got "${stable}"`);
  return {
    owner: addressVar(env, 'EXPECTED_OWNER'),
    treasury: addressVar(env, 'EXPECTED_TREASURY'),
    liquidationFeeBps: intVar(env, 'LIQUIDATION_FEE_BPS'),
    tigrisStable: stable === 'true',
    seeded: envValue(env, 'SEED_AMOUNT') !== '0',
    inputs,
    feeds,
    caps,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------------------------

export type HubTarget = { network: NetworkName; deployment: HubDeployment; client: PublicClient };
export type SpokeTarget = { network: NetworkName; deployment: SpokeDeployment; client: PublicClient };
type Target = HubTarget | SpokeTarget;

/** Receives the deploy scripts' seed-deposit shares (ERC-4626 inflation hardening). */
export const SEED_RECEIVER: Address = '0x000000000000000000000000000000000000dEaD';
const MAX_UINT = 2n ** 256n - 1n;
/** PToken's virtual share offset: an empty pool mints 10^6 shares per underlying unit (DeployHub scales caps by it). */
const SHARE_OFFSET = 10n ** 6n;
/** Pyth-only keys: without a Pyth API key nobody can refresh them when Mezo's pusher stops. */
const PUSH_ONLY: PriceSymbol[] = ['MUSD', 'MEZO'];

/** Everything DeployHub records; supraPull may be the zero address (no Supra source). */
const HUB_CONTRACT_KEYS = [
  'oracleRouter',
  'vaultManager',
  'wormholeAdapter',
  'leverageManager',
  'keeperGateway',
  'pMUSD',
  'pMEZO',
  'swapLeverageManager',
  'tigrisPool',
  'tigrisRouter',
  'tigrisFactory',
  'wormhole',
  'pyth',
] as const;
const HUB_TOKEN_KEYS = ['MUSD', 'MEZO', 'BTC'] as const;

/** Mezodot contracts are deployed without proxies, so their bytecode must implement the SDK ABI. */
const HUB_ABIS: [label: string, key: keyof HubDeployment['contracts'], abi: Abi][] = [
  ['VaultManager', 'vaultManager', vaultManagerAbi],
  ['OracleRouter', 'oracleRouter', oracleRouterAbi],
  ['WormholeAdapter', 'wormholeAdapter', wormholeAdapterAbi],
  ['LeverageManager', 'leverageManager', leverageManagerAbi],
  ['KeeperGateway', 'keeperGateway', keeperGatewayAbi],
  ['pMUSD', 'pMUSD', pTokenAbi],
  ['pMEZO', 'pMEZO', pTokenAbi],
  ['SwapLeverageManager', 'swapLeverageManager', swapLeverageManagerAbi],
];

const ownableAbi = [
  { type: 'function', name: 'owner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingOwner', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
] as const;
/** PythSource / SupraSource getters (the SDK ships only the IPriceSource interface). */
const pythSourceAbi = [{ type: 'function', name: 'pyth', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }] as const;
const supraSourceAbi = [{ type: 'function', name: 'pull', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' }] as const;

type CollateralConfig = {
  enabled: boolean;
  isRemote: boolean;
  isShare: boolean;
  token: Address;
  chainId: number;
  remoteToken: Hex;
  decimals: number;
  priceKey: Hex;
  ltvBps: number;
  ltBps: number;
  bonusBps: number;
  cap: bigint;
};

type ExpectedCollateral = {
  label: string;
  kind: 'share' | 'plain' | 'remote';
  priceKey: Hex;
  /** Hub token (pToken or plain token); the spoke token for remote collateral. */
  token: Address;
  /** Where `unitToken`'s decimals are read: the spoke for remote collateral. */
  target: Target;
  /** Token whose decimals the config must carry: the pool asset for shares, the token itself otherwise. */
  unitToken: Address;
  chainId?: number;
  cap?: bigint;
};

const lower = (a: string): string => a.toLowerCase();
const getPath = (obj: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
const amount = (value: bigint, decimals: number): string => (value === MAX_UINT ? 'unlimited' : formatUnits(value, decimals));
const pct = (bps: number): string => `${bps / 100}%`;

/** Checks one environment (hub + spokes) against its deployment JSON, the SDK ABIs and `expect`. */
export async function verifyEnvironment(hub: HubTarget, spokes: SpokeTarget[], expect: Expectations): Promise<Report> {
  const verifier = new Verifier(hub, spokes, expect);
  await verifier.run();
  return verifier.report;
}

class Verifier {
  readonly report = new Report();
  private readonly code = new Map<string, Promise<Hex | undefined>>();
  private owner: Address | undefined;
  /** Collateral configs by id (undefined where the read failed), read in the VaultManager section. */
  private collaterals: (CollateralConfig | undefined)[] = [];

  constructor(
    private readonly hub: HubTarget,
    private readonly spokes: SpokeTarget[],
    private readonly expect: Expectations,
  ) {}

  async run(): Promise<void> {
    this.json();
    await this.chains();
    await this.bytecode();
    await this.ownership();
    await this.vaultManager();
    await this.pools();
    await this.oracle();
    await this.wormhole();
    await this.hubPeripherals();
    await this.swapLeverage();
    for (const spoke of this.spokes) await this.spoke(spoke);
  }

  // --- helpers -----------------------------------------------------------------------------------------

  private get c(): HubDeployment['contracts'] {
    return this.hub.deployment.contracts;
  }

  private get t(): HubDeployment['tokens'] {
    return this.hub.deployment.tokens;
  }

  /** Runs a read; a revert or an RPC error becomes a failed check instead of ending the run. */
  private async probe<T>(check: string, read: () => Promise<T>): Promise<T | undefined> {
    try {
      return await read();
    } catch (err) {
      this.report.fail(check, `call failed: ${errorLine(err)}`);
      return undefined;
    }
  }

  private async expectRead(check: string, read: () => Promise<unknown>, expected: unknown): Promise<void> {
    const value = await this.probe(check, read);
    if (value !== undefined) this.report.equal(check, value, expected);
  }

  /** eth_getCode, once per (network, address). */
  private codeAt(target: Target, address: Address): Promise<Hex | undefined> {
    const key = `${target.network}:${lower(address)}`;
    if (!this.code.has(key)) this.code.set(key, target.client.getCode({ address }));
    return this.code.get(key)!;
  }

  private decimals(target: Target, token: Address): Promise<number> {
    return target.client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' });
  }

  /** Warns when a contract that holds no funds between transactions has a balance of any of `tokens`. */
  private async holdsNothing(label: string, holder: Address, tokens: [string, Address | undefined][]): Promise<void> {
    for (const [symbol, token] of tokens) {
      if (!token) continue;
      const balance = await this.hub.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }).catch(() => undefined);
      if (!balance) continue;
      const decimals = await this.decimals(this.hub, token).catch(() => 18);
      this.report.warn(`${label} ${symbol} balance`, `holds ${formatUnits(balance, decimals)} ${symbol}; it should hold nothing between transactions`);
    }
  }

  /** Static checks of one deployment JSON: shape, identity against the SDK network table, deploy inputs. */
  private checkJson(target: Target, contractKeys: readonly string[], tokenKeys: readonly string[]): void {
    const r = this.report;
    const { network, deployment: d } = target;
    const file = `${network}.json`;
    const net = NETWORKS[network];
    r.equal(`${file} network`, d.network, network);
    r.equal(`${file} chainId`, d.chainId, net.chain.id);
    r.equal(`${file} wormholeChainId`, d.wormholeChainId, net.wormholeChainId);
    r.that(
      `${file} startBlock`,
      Number.isInteger(d.startBlock) && d.startBlock > 0,
      String(d.startBlock),
      `not a positive block number: ${String(d.startBlock)}`,
    );
    for (const [group, keys] of [
      ['contracts', contractKeys],
      ['tokens', tokenKeys],
    ] as const) {
      for (const key of keys) {
        const v = getPath(d, `${group}.${key}`);
        const ok = typeof v === 'string' && isAddress(v, { strict: false }) && lower(v) !== zeroAddress;
        r.that(`${file} ${group}.${key}`, ok, String(v), v === undefined ? 'missing' : `not a deployed address: ${String(v)}`);
      }
    }
    for (const [path, value] of Object.entries(this.expect.inputs[network] ?? {})) {
      r.equal(`${file} ${path} = deploy input`, getPath(d, path) ?? 'missing', value);
    }
  }

  // --- sections ----------------------------------------------------------------------------------------

  private json(): void {
    const r = this.report;
    const { network, deployment: d } = this.hub;
    r.begin('deployment JSON');
    r.equal(`${network}.json role`, d.role, 'hub');
    this.checkJson(this.hub, HUB_CONTRACT_KEYS, HUB_TOKEN_KEYS);
    for (const s of PRICE_SYMBOLS) {
      const id = getPath(d, `priceFeeds.${s}`);
      r.that(
        `${network}.json priceFeeds.${s}`,
        typeof id === 'string' && /^0x[0-9a-fA-F]{64}$/.test(id),
        String(id),
        id === undefined ? 'missing' : `not a Pyth price id: ${String(id)}`,
      );
    }
    for (const spoke of this.spokes) {
      r.equal(`${spoke.network}.json role`, spoke.deployment.role, 'spoke');
      this.checkJson(spoke, ['spokeGateway', 'wormhole'], ['WETH', 'USDC']);
    }
  }

  private async chains(): Promise<void> {
    const r = this.report;
    r.begin('chain');
    for (const target of [this.hub, ...this.spokes]) {
      const { network, deployment, client } = target;
      await this.expectRead(`${network} eth_chainId`, () => client.getChainId(), deployment.chainId);
      const block = await this.probe(`${network} latest block`, () => client.getBlockNumber());
      if (block !== undefined) {
        r.that(
          `${network} startBlock reached`,
          block >= BigInt(deployment.startBlock),
          `latest ${block}`,
          `startBlock ${deployment.startBlock} is ahead of the chain (latest ${block})`,
        );
      }
    }
  }

  /** Every recorded address has code; every Mezodot contract implements its SDK ABI. */
  private async bytecode(): Promise<void> {
    const r = this.report;
    r.begin('code');
    const entries: [Target, string, unknown][] = [this.hub, ...this.spokes].flatMap((target) => [
      ...Object.entries(target.deployment.contracts).map(([k, a]): [Target, string, unknown] => [target, `contracts.${k}`, a]),
      ...Object.entries(target.deployment.tokens).map(([k, a]): [Target, string, unknown] => [target, `tokens.${k}`, a]),
    ]);
    const results = await Promise.all(
      entries.map(async ([target, label, address]): Promise<[Status, string, string] | null> => {
        const check = `${target.network} ${label}`;
        if (typeof address !== 'string' || !isAddress(address, { strict: false })) return null; // reported with the JSON
        if (lower(address) === zeroAddress) return ['info', check, 'not configured (zero address)'];
        try {
          const code = await this.codeAt(target, address);
          const size = code ? (code.length - 2) / 2 : 0;
          return size > 0 ? ['pass', check, `${address} (${size} bytes)`] : ['fail', check, `no code at ${address}`];
        } catch (err) {
          return ['fail', check, `eth_getCode failed: ${errorLine(err)}`];
        }
      }),
    );
    for (const result of results) if (result) r.add(...result);

    r.begin('ABI');
    const abiTargets: [Target, string, Address | undefined, Abi][] = [
      ...HUB_ABIS.map(([label, key, abi]): [Target, string, Address | undefined, Abi] => [this.hub, label, this.c[key], abi]),
      ...this.spokes.map((s): [Target, string, Address | undefined, Abi] => [s, 'SpokeGateway', s.deployment.contracts.spokeGateway, spokeGatewayAbi]),
    ];
    for (const [target, label, address, abi] of abiTargets) {
      if (!address) continue;
      const code = await this.codeAt(target, address).catch(() => undefined);
      if (!code || code === '0x') continue; // reported by the code section
      const missing = missingFunctions(code, abi);
      r.that(
        `${target.network} ${label} implements the SDK ABI`,
        missing.length === 0,
        `all ${abi.filter((i) => i.type === 'function').length} functions`,
        `deployed bytecode lacks ${missing.join(', ')}: the SDK ABIs and this deployment come from different contract versions`,
      );
    }
  }

  private async ownership(): Promise<void> {
    const r = this.report;
    r.begin('ownership');
    const owned: [string, Target, Address | undefined][] = [
      ['VaultManager', this.hub, this.c.vaultManager],
      ['OracleRouter', this.hub, this.c.oracleRouter],
      ['WormholeAdapter', this.hub, this.c.wormholeAdapter],
      ['pMUSD', this.hub, this.c.pMUSD],
      ['pMEZO', this.hub, this.c.pMEZO],
      ...this.spokes.map((s): [string, Target, Address | undefined] => [`${s.network} SpokeGateway`, s, s.deployment.contracts.spokeGateway]),
    ];
    const reads = await Promise.all(
      owned.map(([, { client }, address]) =>
        address
          ? Promise.all([
              client.readContract({ address, abi: ownableAbi, functionName: 'owner' }).catch((err: unknown) => new Error(errorLine(err))),
              client.readContract({ address, abi: ownableAbi, functionName: 'pendingOwner' }).catch(() => undefined),
            ])
          : null,
      ),
    );
    const vmOwner = reads[0]?.[0];
    this.owner = this.expect.owner ?? (typeof vmOwner === 'string' ? vmOwner : undefined);
    owned.forEach(([label], i) => {
      const read = reads[i];
      if (!read) return;
      const [owner, pending] = read;
      if (owner instanceof Error) r.fail(`${label}.owner()`, `call failed: ${owner.message}`);
      else if (this.owner) r.equal(`${label}.owner()`, owner, this.owner);
      if (pending && lower(pending) !== zeroAddress) r.warn(`${label}.pendingOwner()`, `ownership transfer to ${pending} awaits acceptOwnership()`);
    });
  }

  private async vaultManager(): Promise<void> {
    const r = this.report;
    const { client } = this.hub;
    const vm = this.c.vaultManager;
    if (!vm) return;
    r.begin('VaultManager');
    type Getter = 'oracle' | 'adapter' | 'treasury' | 'liquidationFeeBps' | 'MAX_LIQUIDATION_FEE_BPS' | 'paused' | 'marketCount';
    const read = <F extends Getter>(functionName: F) => client.readContract({ address: vm, abi: vaultManagerAbi, functionName });
    await this.expectRead('VaultManager.oracle()', () => read('oracle'), this.c.oracleRouter);
    await this.expectRead('VaultManager.adapter()', () => read('adapter'), this.c.wormholeAdapter);
    const treasury = this.expect.treasury ?? this.owner;
    if (treasury) await this.expectRead('VaultManager.treasury()', () => read('treasury'), treasury);
    const fee = await this.probe('VaultManager.liquidationFeeBps()', () => read('liquidationFeeBps'));
    if (fee !== undefined) {
      if (this.expect.liquidationFeeBps !== undefined) r.equal('VaultManager.liquidationFeeBps()', fee, this.expect.liquidationFeeBps);
      else {
        const max = await read('MAX_LIQUIDATION_FEE_BPS').catch(() => 5_000);
        r.that('VaultManager.liquidationFeeBps()', fee <= max, `${fee} (${pct(fee)} of each liquidation bonus)`, `${fee} exceeds the ${max} bps maximum`);
      }
    }
    if (await this.probe('VaultManager.paused()', () => read('paused'))) r.warn('VaultManager.paused()', 'paused: new borrows are blocked');

    // Markets: MUSD then MEZO, each priced by its own key at its asset's decimals.
    const expectedMarkets: [PriceSymbol, Address | undefined, Address | undefined][] = [
      ['MUSD', this.c.pMUSD, this.t.MUSD],
      ['MEZO', this.c.pMEZO, this.t.MEZO],
    ];
    const marketCount = await this.probe('VaultManager.marketCount()', () => read('marketCount'));
    if (marketCount !== undefined) r.equal('VaultManager.marketCount()', marketCount, expectedMarkets.length);
    for (let id = 0; id < Math.min(Number(marketCount ?? 0), expectedMarkets.length); id++) {
      const [symbol, pool, asset] = expectedMarkets[id];
      const check = `market ${id} (${symbol})`;
      const m = await this.probe(check, () => client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'markets', args: [BigInt(id)] }));
      if (!m) continue;
      r.equal(`${check} pool`, m.pool, pool ?? 'missing');
      r.equal(`${check} priceKey`, m.priceKey, PRICE_KEYS[symbol]);
      if (asset) {
        const decimals = await this.probe(`${symbol} decimals()`, () => this.decimals(this.hub, asset));
        if (decimals !== undefined) r.equal(`${check} decimals`, m.decimals, decimals);
      }
      if (!m.enabled) r.warn(`${check} enabled`, 'disabled: no new borrows');
    }

    await this.collateralTable();
  }

  /** The collateral list is fully determined by the deployment: pMUSD, pMEZO, BTC, then WETH and USDC per spoke. */
  private expectedCollaterals(): ExpectedCollateral[] {
    const caps = this.expect.caps;
    const out: ExpectedCollateral[] = [];
    if (this.c.pMUSD && this.t.MUSD)
      out.push({ label: 'pMUSD', kind: 'share', priceKey: PRICE_KEYS.MUSD, token: this.c.pMUSD, target: this.hub, unitToken: this.t.MUSD });
    if (this.c.pMEZO && this.t.MEZO) {
      // DeployHub sets the cap in MEZO and converts it to shares.
      const cap = caps.MEZO_COLLATERAL_CAP === undefined ? undefined : caps.MEZO_COLLATERAL_CAP * SHARE_OFFSET;
      out.push({ label: 'pMEZO', kind: 'share', priceKey: PRICE_KEYS.MEZO, token: this.c.pMEZO, target: this.hub, unitToken: this.t.MEZO, cap });
    }
    if (this.t.BTC)
      out.push({
        label: 'BTC',
        kind: 'plain',
        priceKey: PRICE_KEYS.BTC,
        token: this.t.BTC,
        target: this.hub,
        unitToken: this.t.BTC,
        cap: caps.BTC_COLLATERAL_CAP,
      });
    for (const s of this.spokes) {
      const { WETH, USDC } = s.deployment.tokens;
      const chainId = s.deployment.wormholeChainId;
      out.push({ label: `${s.network} WETH`, kind: 'remote', priceKey: PRICE_KEYS.ETH, token: WETH, target: s, unitToken: WETH, chainId });
      out.push({ label: `${s.network} USDC`, kind: 'remote', priceKey: PRICE_KEYS.USDC, token: USDC, target: s, unitToken: USDC, chainId });
    }
    return out;
  }

  private async collateralTable(): Promise<void> {
    const r = this.report;
    const { client } = this.hub;
    const vm = this.c.vaultManager;
    const expected = this.expectedCollaterals();
    const count = await this.probe('VaultManager.collateralCount()', () =>
      client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collateralCount' }),
    );
    if (count === undefined) return;
    r.equal('VaultManager.collateralCount()', count, expected.length);
    this.collaterals = await Promise.all(
      Array.from({ length: Number(count) }, (_, id) =>
        this.probe(`collateral ${id}`, () => client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collaterals', args: [BigInt(id)] })),
      ),
    );
    const matched = new Set<number>();
    for (const e of expected) {
      const id = this.collaterals.findIndex(
        (c, i) =>
          !matched.has(i) &&
          c !== undefined &&
          (e.kind === 'remote'
            ? c.isRemote && c.chainId === e.chainId && lower(c.remoteToken) === toBytes32(e.token)
            : !c.isRemote && lower(c.token) === lower(e.token)),
      );
      if (id === -1) {
        r.fail(`collateral ${e.label}`, 'not listed in VaultManager');
        continue;
      }
      matched.add(id);
      const c = this.collaterals[id]!;
      const check = `collateral ${id} (${e.label})`;
      r.equal(`${check} kind`, c.isRemote ? 'remote' : c.isShare ? 'share' : 'plain', e.kind);
      r.equal(`${check} priceKey`, c.priceKey, e.priceKey);
      const decimals = await this.probe(`${check} token decimals`, () => this.decimals(e.target, e.unitToken));
      if (decimals !== undefined) r.equal(`${check} decimals`, c.decimals, decimals);
      if (e.kind === 'remote') {
        await this.expectRead(
          `${check} remoteCollateralId`,
          () => client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'remoteCollateralId', args: [e.chainId!, toBytes32(e.token)] }),
          id + 1,
        );
      }
      if (e.cap !== undefined) r.equal(`${check} cap`, c.cap, e.cap);
      if (!c.enabled) r.warn(`${check} enabled`, 'disabled: adds nothing to borrow limits (still counts for health)');
      r.info(`${check} risk`, `LTV ${pct(c.ltvBps)}, LT ${pct(c.ltBps)}, bonus ${pct(c.bonusBps)}, cap ${c.cap === MAX_UINT ? 'unlimited' : c.cap.toString()}`);
    }
    this.collaterals.forEach((c, id) => {
      if (c && !matched.has(id))
        r.fail(`collateral ${id}`, `not expected by the deployment JSON (token ${c.isRemote ? c.remoteToken : c.token}, chain ${c.chainId})`);
    });
  }

  private async pools(): Promise<void> {
    const r = this.report;
    const { client } = this.hub;
    const caps = this.expect.caps;
    const pools: [string, Address | undefined, Address | undefined, bigint | undefined, bigint | undefined][] = [
      ['pMUSD', this.c.pMUSD, this.t.MUSD, caps.MUSD_SUPPLY_CAP, caps.MUSD_BORROW_CAP],
      ['pMEZO', this.c.pMEZO, this.t.MEZO, caps.MEZO_SUPPLY_CAP, caps.MEZO_BORROW_CAP],
    ];
    type Getter =
      | 'vaultManager'
      | 'asset'
      | 'reserveFactor'
      | 'MAX_RESERVE_FACTOR'
      | 'supplyCap'
      | 'borrowCap'
      | 'paused'
      | 'cash'
      | 'totalBorrows'
      | 'totalReserves'
      | 'interestRateModel';
    for (const [label, pool, asset, supplyCap, borrowCap] of pools) {
      if (!pool) continue;
      r.begin(label);
      const read = <F extends Getter>(functionName: F) => client.readContract({ address: pool, abi: pTokenAbi, functionName });
      await this.expectRead(`${label}.vaultManager()`, () => read('vaultManager'), this.c.vaultManager);
      if (asset) await this.expectRead(`${label}.asset()`, () => read('asset'), asset);
      const decimals = asset ? await this.decimals(this.hub, asset).catch(() => 18) : 18;
      const rf = await this.probe(`${label}.reserveFactor()`, () => read('reserveFactor'));
      if (rf !== undefined) {
        const max = await read('MAX_RESERVE_FACTOR').catch(() => 3n * 10n ** 17n);
        r.that(`${label}.reserveFactor()`, rf <= max, `${formatUnits(rf * 100n, 18)}% of interest to reserves`, `${rf} exceeds MAX_RESERVE_FACTOR ${max}`);
      }
      for (const [name, expected] of [
        ['supplyCap', supplyCap],
        ['borrowCap', borrowCap],
      ] as const) {
        const v = await this.probe(`${label}.${name}()`, () => read(name));
        if (v === undefined) continue;
        if (expected !== undefined) r.equal(`${label}.${name}()`, v, expected);
        else if (v === MAX_UINT) r.warn(`${label}.${name}()`, 'unlimited');
        else r.info(`${label}.${name}()`, amount(v, decimals));
      }
      if (await this.probe(`${label}.paused()`, () => read('paused'))) r.warn(`${label}.paused()`, 'paused: deposits and borrows are blocked');
      const irm = await this.probe(`${label}.interestRateModel()`, () => read('interestRateModel'));
      if (irm) {
        const code = await this.codeAt(this.hub, irm).catch(() => undefined);
        r.that(`${label}.interestRateModel()`, Boolean(code && code !== '0x'), irm, `no code at ${irm}`);
      }
      const [cash, borrows, reserves] = await Promise.all([read('cash'), read('totalBorrows'), read('totalReserves')]).catch(() => [
        undefined,
        undefined,
        undefined,
      ]);
      if (cash !== undefined && borrows !== undefined && reserves !== undefined) {
        r.that(
          `${label} solvency`,
          cash + borrows >= reserves,
          `cash ${amount(cash, decimals)} + borrows ${amount(borrows, decimals)} ≥ reserves ${amount(reserves, decimals)}`,
          `cash ${cash} + borrows ${borrows} < reserves ${reserves}`,
        );
      }
      const seed = await this.probe(`${label} seed deposit`, () =>
        client.readContract({ address: pool, abi: pTokenAbi, functionName: 'balanceOf', args: [SEED_RECEIVER] }),
      );
      if (seed !== undefined) {
        if (seed > 0n) r.pass(`${label} seed deposit`, `${seed} shares at ${SEED_RECEIVER}`);
        else if (this.expect.seeded) r.fail(`${label} seed deposit`, `no shares at ${SEED_RECEIVER}: seed the pool (docs/DEPLOY.md, step 1)`);
        else r.info(`${label} seed deposit`, 'none (SEED_AMOUNT=0)');
      }
    }
  }

  private async oracle(): Promise<void> {
    const r = this.report;
    const { client } = this.hub;
    const router = this.c.oracleRouter;
    if (!router) return;
    r.begin('OracleRouter');
    const pythSource = await this.probe('OracleRouter.sources(PYTH)', () =>
      client.readContract({ address: router, abi: oracleRouterAbi, functionName: 'sources', args: [SOURCE_TAG.PYTH] }),
    );
    if (pythSource && r.that('OracleRouter.sources(PYTH)', lower(pythSource) !== zeroAddress, pythSource, 'no Pyth source registered')) {
      await this.expectRead('PythSource.pyth()', () => client.readContract({ address: pythSource, abi: pythSourceAbi, functionName: 'pyth' }), this.c.pyth);
    }
    const supraPull = this.c.supraPull && lower(this.c.supraPull) !== zeroAddress ? this.c.supraPull : undefined;
    const supraSource = await this.probe('OracleRouter.sources(SUPRA)', () =>
      client.readContract({ address: router, abi: oracleRouterAbi, functionName: 'sources', args: [SOURCE_TAG.SUPRA] }),
    );
    if (supraSource !== undefined) {
      if (!supraPull) r.equal('OracleRouter.sources(SUPRA)', supraSource, zeroAddress);
      else if (r.that('OracleRouter.sources(SUPRA)', lower(supraSource) !== zeroAddress, supraSource, 'no Supra source registered')) {
        await this.expectRead('SupraSource.pull()', () => client.readContract({ address: supraSource, abi: supraSourceAbi, functionName: 'pull' }), supraPull);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    for (const s of PRICE_SYMBOLS) {
      const key = PRICE_KEYS[s];
      const policy = this.expect.feeds[s] ?? {};
      const feed = await this.probe(`feed ${s}`, () => client.readContract({ address: router, abi: oracleRouterAbi, functionName: 'feeds', args: [key] }));
      if (!feed) continue;
      const primaryOk = r.that(
        `feed ${s} primary`,
        feed.primary.source === SOURCE_TAG.PYTH,
        `Pyth, ${feed.primary.maxAge} s, confidence cap ${pct(feed.maxConfBps)}`,
        feed.primary.source === 0 ? 'no feed for this key' : `source tag ${feed.primary.source}, expected Pyth`,
      );
      if (!primaryOk) continue;
      r.equal(`feed ${s} Pyth id = priceFeeds.${s}`, feed.primary.id, getPath(this.hub.deployment, `priceFeeds.${s}`) ?? 'missing');
      if (policy.maxAge !== undefined) r.equal(`feed ${s} Pyth max age`, feed.primary.maxAge, policy.maxAge);
      if (policy.maxConfBps !== undefined) r.equal(`feed ${s} confidence cap`, feed.maxConfBps, policy.maxConfBps);

      if (feed.secondary.source === 0) {
        if (typeof policy.supraPair === 'number') r.fail(`feed ${s} secondary`, `missing: Supra pair ${policy.supraPair} expected`);
        else if (s === 'ETH') r.warn(`feed ${s} secondary`, 'none: Pyth ETH is not pushed on Mezo, so ETH is priced only by a Pyth pull update');
        else r.info(`feed ${s} secondary`, 'none');
      } else {
        const pair = Number(BigInt(feed.secondary.id));
        const isSupra = r.that(
          `feed ${s} secondary`,
          feed.secondary.source === SOURCE_TAG.SUPRA,
          `Supra pair ${pair}, ${feed.secondary.maxAge} s, divergence cap ${pct(feed.maxDivergenceBps)}`,
          `source tag ${feed.secondary.source}, expected Supra`,
        );
        if (isSupra) {
          // The agent's /oracle/update relay requests the SDK's SUPRA_PAIRS: any other pair is never refreshed.
          r.equal(`feed ${s} Supra pair = SDK SUPRA_PAIRS.${s}`, pair, SUPRA_PAIRS[s] ?? 'none');
          if (policy.supraPair === null) r.fail(`feed ${s} Supra pair`, `pair ${pair} configured, but the deploy environment sets no ${s}_SUPRA_PAIR`);
          else if (policy.supraPair !== undefined) r.equal(`feed ${s} Supra pair = ${s}_SUPRA_PAIR`, pair, policy.supraPair);
          if (policy.supraMaxAge !== undefined) r.equal(`feed ${s} Supra max age`, feed.secondary.maxAge, policy.supraMaxAge);
          if (policy.divergenceBps !== undefined) r.equal(`feed ${s} divergence cap`, feed.maxDivergenceBps, policy.divergenceBps);
        }
      }

      // Liveness is reported, not judged: pull-only keys are unavailable between transactions by design.
      const info = await client.readContract({ address: router, abi: oracleRouterAbi, functionName: 'getPriceInfo', args: [key] }).catch(() => undefined);
      if (!info) continue;
      const [ok, price, validUntil] = info;
      if (ok) r.info(`price ${s}`, `$${Number(formatUnits(price, 18)).toPrecision(6)}, valid for ${Number(validUntil) - now} s`);
      else if (PUSH_ONLY.includes(s)) r.warn(`price ${s}`, 'unavailable: borrows and liquidations touching it revert until a Pyth push (docs/RUNBOOK.md)');
      else r.info(`price ${s}`, 'on demand: a transaction must attach a pull update');
    }
  }

  private async wormhole(): Promise<void> {
    const r = this.report;
    const { client, deployment: d } = this.hub;
    const adapter = this.c.wormholeAdapter;
    if (!adapter) return;
    r.begin('WormholeAdapter');
    type Getter = 'vaultManager' | 'wormhole' | 'localChainId' | 'consistencyLevel';
    const read = <F extends Getter>(functionName: F) => client.readContract({ address: adapter, abi: wormholeAdapterAbi, functionName });
    await this.expectRead('WormholeAdapter.vaultManager()', () => read('vaultManager'), this.c.vaultManager);
    await this.expectRead('WormholeAdapter.wormhole()', () => read('wormhole'), this.c.wormhole);
    await this.expectRead('WormholeAdapter.localChainId()', () => read('localChainId'), d.wormholeChainId);
    if (this.c.wormhole) {
      await this.expectRead(
        'Wormhole Core chainId()',
        () => client.readContract({ address: this.c.wormhole, abi: wormholeAbi, functionName: 'chainId' }),
        d.wormholeChainId,
      );
    }
    const level = await read('consistencyLevel').catch(() => undefined);
    if (level !== undefined) r.info('WormholeAdapter.consistencyLevel()', String(level));
    // Hub → spoke direction (spoke → hub is checked per spoke): one registered emitter per spoke chain.
    for (const s of this.spokes) {
      await this.expectRead(
        `WormholeAdapter.spokeEmitter(${s.deployment.wormholeChainId})`,
        () => client.readContract({ address: adapter, abi: wormholeAdapterAbi, functionName: 'spokeEmitter', args: [s.deployment.wormholeChainId] }),
        toBytes32(s.deployment.contracts.spokeGateway),
      );
    }
  }

  /** LeverageManager (MUSD loop) and KeeperGateway: pointed at this hub and the right market and collateral. */
  private async hubPeripherals(): Promise<void> {
    const r = this.report;
    const { client } = this.hub;
    const vm = this.c.vaultManager;
    const lev = this.c.leverageManager;
    if (lev) {
      r.begin('LeverageManager');
      type Getter = 'vaultManager' | 'pool' | 'asset' | 'marketId' | 'collateralId';
      const read = <F extends Getter>(functionName: F) => client.readContract({ address: lev, abi: leverageManagerAbi, functionName });
      await this.expectRead('LeverageManager.vaultManager()', () => read('vaultManager'), vm);
      await this.expectRead('LeverageManager.pool()', () => read('pool'), this.c.pMUSD);
      await this.expectRead('LeverageManager.asset()', () => read('asset'), this.t.MUSD);
      await this.marketIsPMUSD('LeverageManager', await this.probe('LeverageManager.marketId()', () => read('marketId')));
      const id = await this.probe('LeverageManager.collateralId()', () => read('collateralId'));
      if (id !== undefined) {
        const c = this.collaterals[Number(id)];
        r.that(
          `LeverageManager collateral ${id}`,
          Boolean(c?.isShare && lower(c.token) === lower(this.c.pMUSD)),
          'pMUSD shares',
          'not the pMUSD share collateral',
        );
      }
      await this.holdsNothing('LeverageManager', lev, [
        ['MUSD', this.t.MUSD],
        ['pMUSD', this.c.pMUSD],
      ]);
    }

    const keepers = this.c.keeperGateway;
    if (keepers) {
      r.begin('KeeperGateway');
      await this.expectRead(
        'KeeperGateway.vaultManager()',
        () => client.readContract({ address: keepers, abi: keeperGatewayAbi, functionName: 'vaultManager' }),
        vm,
      );
      await this.expectRead(
        'KeeperGateway.adapter()',
        () => client.readContract({ address: keepers, abi: keeperGatewayAbi, functionName: 'adapter' }),
        this.c.wormholeAdapter,
      );
      // It refunds all of its BTC to each liquidator; a balance here goes to whoever liquidates next.
      const btc = await client.getBalance({ address: keepers }).catch(() => undefined);
      if (btc) r.warn('KeeperGateway BTC balance', `holds ${formatUnits(btc, 18)} BTC; the next liquidation refunds it to that keeper`);
    }
  }

  private async marketIsPMUSD(label: string, marketId: bigint | undefined): Promise<void> {
    if (marketId === undefined) return;
    const m = await this.probe(`${label} market ${marketId}`, () =>
      this.hub.client.readContract({ address: this.c.vaultManager, abi: vaultManagerAbi, functionName: 'markets', args: [marketId] }),
    );
    if (m) this.report.equal(`${label} market ${marketId} pool`, m.pool, this.c.pMUSD);
  }

  /** BTC leverage: the desk must flash-swap on Tigris' own MUSD/BTC pool, never on an arbitrary contract. */
  private async swapLeverage(): Promise<void> {
    const r = this.report;
    const { client } = this.hub;
    const swap = this.c.swapLeverageManager;
    if (!swap) return;
    r.begin('SwapLeverageManager');
    type Getter = 'vaultManager' | 'pool' | 'debtAsset' | 'collateral' | 'marketId' | 'collateralId' | 'pair';
    const read = <F extends Getter>(functionName: F) => client.readContract({ address: swap, abi: swapLeverageManagerAbi, functionName });
    await this.expectRead('SwapLeverageManager.vaultManager()', () => read('vaultManager'), this.c.vaultManager);
    await this.expectRead('SwapLeverageManager.pool()', () => read('pool'), this.c.pMUSD);
    await this.expectRead('SwapLeverageManager.debtAsset()', () => read('debtAsset'), this.t.MUSD);
    await this.expectRead('SwapLeverageManager.collateral()', () => read('collateral'), this.t.BTC ?? 'missing');
    await this.marketIsPMUSD('SwapLeverageManager', await this.probe('SwapLeverageManager.marketId()', () => read('marketId')));
    const id = await this.probe('SwapLeverageManager.collateralId()', () => read('collateralId'));
    if (id !== undefined) {
      const c = this.collaterals[Number(id)];
      const isBtc = Boolean(c && !c.isRemote && !c.isShare && this.t.BTC && lower(c.token) === lower(this.t.BTC));
      r.that(`SwapLeverageManager collateral ${id}`, isBtc, 'BTC (plain)', 'not the plain BTC collateral');
    }
    await this.holdsNothing('SwapLeverageManager', swap, [
      ['MUSD', this.t.MUSD],
      ['BTC', this.t.BTC],
    ]);

    const pair = await this.probe('SwapLeverageManager.pair()', () => read('pair'));
    const { MUSD, BTC } = this.t;
    if (!pair || !MUSD || !BTC) return;
    r.equal('SwapLeverageManager.pair() = contracts.tigrisPool', pair, this.c.tigrisPool ?? 'missing');
    const stable = this.expect.tigrisStable;
    const factory = this.c.tigrisFactory;
    if (factory) {
      await this.expectRead(
        `TigrisFactory.getPool(MUSD, BTC, ${stable})`,
        () => client.readContract({ address: factory, abi: tigrisPoolFactoryAbi, functionName: 'getPool', args: [MUSD, BTC, stable] }),
        pair,
      );
    }
    const [token0, token1, poolStable] = await Promise.all([
      this.probe('TigrisPool.token0()', () => client.readContract({ address: pair, abi: tigrisPoolAbi, functionName: 'token0' })),
      this.probe('TigrisPool.token1()', () => client.readContract({ address: pair, abi: tigrisPoolAbi, functionName: 'token1' })),
      this.probe('TigrisPool.stable()', () => client.readContract({ address: pair, abi: tigrisPoolAbi, functionName: 'stable' })),
    ]);
    if (token0 && token1) {
      const tokens = [lower(token0), lower(token1)].sort().join();
      r.that('TigrisPool tokens', tokens === [lower(MUSD), lower(BTC)].sort().join(), 'MUSD/BTC', `${token0}/${token1}`);
    }
    if (poolStable !== undefined) r.equal('TigrisPool.stable()', poolStable, stable);

    // The desk prices swaps with the pool's own getAmountOut, apps and keepers with the router: one hop must agree.
    const amountIn = 10n ** 18n;
    const quote = await this.probe('TigrisPool.getAmountOut(1 MUSD)', () =>
      client.readContract({ address: pair, abi: tigrisPoolAbi, functionName: 'getAmountOut', args: [amountIn, MUSD] }),
    );
    if (quote === undefined) return;
    r.that('TigrisPool.getAmountOut(1 MUSD)', quote > 0n, `${formatUnits(quote, 18)} BTC`, 'zero: the pool has no liquidity');
    const router = this.c.tigrisRouter;
    if (router && factory) {
      const amounts = await this.probe('TigrisRouter.getAmountsOut(1 MUSD)', () =>
        client.readContract({
          address: router,
          abi: tigrisRouterAbi,
          functionName: 'getAmountsOut',
          args: [amountIn, [{ from: MUSD, to: BTC, stable, factory }]],
        }),
      );
      if (amounts) r.equal('TigrisRouter.getAmountsOut(1 MUSD) = pool quote', amounts[amounts.length - 1], quote);
    }
    const cash = await client.readContract({ address: this.c.pMUSD, abi: pTokenAbi, functionName: 'cash' }).catch(() => undefined);
    if (cash !== undefined) r.info('BTC leverage capacity', `an open borrows at most pMUSD idle cash: ${formatUnits(cash, 18)} MUSD`);
  }

  private async spoke(s: SpokeTarget): Promise<void> {
    const r = this.report;
    const { client, deployment: d, network } = s;
    const gateway = d.contracts.spokeGateway;
    if (!gateway) return;
    r.begin(`${network} SpokeGateway`);
    type Getter = 'hubEmitter' | 'hubChainId' | 'localChainId' | 'wormhole' | 'paused';
    const read = <F extends Getter>(functionName: F) => client.readContract({ address: gateway, abi: spokeGatewayAbi, functionName });
    // Spoke → hub direction: DEPOSITs name the hub adapter, RELEASEs are accepted only from it.
    if (this.c.wormholeAdapter) await this.expectRead('SpokeGateway.hubEmitter()', () => read('hubEmitter'), toBytes32(this.c.wormholeAdapter));
    await this.expectRead('SpokeGateway.hubChainId()', () => read('hubChainId'), this.hub.deployment.wormholeChainId);
    await this.expectRead('SpokeGateway.localChainId()', () => read('localChainId'), d.wormholeChainId);
    await this.expectRead('SpokeGateway.wormhole()', () => read('wormhole'), d.contracts.wormhole);
    if (d.contracts.wormhole) {
      await this.expectRead(
        'Wormhole Core chainId()',
        () => client.readContract({ address: d.contracts.wormhole, abi: wormholeAbi, functionName: 'chainId' }),
        d.wormholeChainId,
      );
    }
    if (await this.probe('SpokeGateway.paused()', () => read('paused'))) r.warn('SpokeGateway.paused()', 'paused: new deposits are blocked');

    const caps = { WETH: this.expect.caps.WETH_CAP, USDC: this.expect.caps.USDC_CAP };
    for (const symbol of ['WETH', 'USDC'] as const) {
      const token = d.tokens[symbol];
      if (!token) continue;
      const [cfg, locked, held, decimals] = await Promise.all([
        this.probe(`${symbol} config`, () => client.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'tokens', args: [token] })),
        this.probe(`${symbol} locked`, () => client.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'locked', args: [token] })),
        this.probe(`${symbol} held`, () => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [gateway] })),
        this.decimals(s, token).catch(() => 18),
      ]);
      if (cfg) {
        const [allowed, cap] = cfg;
        r.that(`${symbol} allowed`, allowed, 'yes', 'not allowlisted: deposits revert');
        if (caps[symbol] !== undefined) r.equal(`${symbol} cap`, cap, caps[symbol]);
        else if (cap === MAX_UINT) r.warn(`${symbol} cap`, 'unlimited');
        else r.info(`${symbol} cap`, amount(cap, decimals));
      }
      if (locked === undefined || held === undefined) continue;
      // Deferred releases stay in the gateway as claimable, so what it holds covers locked plus claimable.
      r.that(`${symbol} held ≥ locked`, held >= locked, `${amount(held, decimals)} ≥ ${amount(locked, decimals)}`, `holds ${held}, but ${locked} is locked`);
      // Cross-chain backing: the hub never credits more than the spoke holds locked for it.
      const idPlusOne = await this.probe(`${symbol} hub collateral id`, () =>
        this.hub.client.readContract({
          address: this.c.vaultManager,
          abi: vaultManagerAbi,
          functionName: 'remoteCollateralId',
          args: [d.wormholeChainId, toBytes32(token)],
        }),
      );
      if (!idPlusOne) continue;
      const credited = await this.probe(`${symbol} hub credit`, () =>
        this.hub.client.readContract({ address: this.c.vaultManager, abi: vaultManagerAbi, functionName: 'totalCollateral', args: [idPlusOne - 1n] }),
      );
      if (credited !== undefined) {
        r.that(
          `${symbol} hub credit ≤ locked`,
          credited <= locked,
          `${amount(credited, decimals)} ≤ ${amount(locked, decimals)}`,
          `hub credits ${credited}, but only ${locked} is locked on ${network}`,
        );
      }
    }
  }
}
