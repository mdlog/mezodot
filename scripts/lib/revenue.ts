import { formatUnits, getAbiItem, getAddress, isAddressEqual, pad, type Address, type Hex, type PublicClient } from 'viem';
import {
  NETWORKS,
  getLogsChunked,
  oracleRouterAbi,
  pTokenAbi,
  symbolForPriceKey,
  vaultManagerAbi,
  wormholeAdapterAbi,
  type HubDeployment,
  type NetworkName,
  type SpokeDeployment,
} from '../../packages/sdk/src/index';

/**
 * Protocol revenue as it sits on-chain (docs/REVENUE.md): pool reserves (reserve factor on interest plus the 0.09%
 * flash fee, less withdrawals and absorbed bad debt) and the treasury's share of liquidation bonuses, held as its
 * collateral in VaultManager custody. Every value is read at one block; lifetime totals come from events.
 */

const WAD = 10n ** 18n;

// ---------------------------------------------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------------------------------------------

export type PoolAccrual = { totalBorrows: bigint; totalReserves: bigint; reserveFactor: bigint; borrowRatePerSecond: bigint; accrualTimestamp: bigint };

/**
 * Reserves after accruing interest up to `now`, as MezodotPool._accrued() computes them (`borrowRatePerSecond()` reads
 * the same state, so the result is exact for that block). `withdrawReserves` accrues first, so a later transaction can
 * always withdraw at least this much, cash permitting.
 */
export function accruedReserves(p: PoolAccrual, now: bigint): bigint {
  const elapsed = now > p.accrualTimestamp ? now - p.accrualTimestamp : 0n;
  if (elapsed === 0n || p.totalBorrows === 0n) return p.totalReserves;
  const interest = (p.totalBorrows * (p.borrowRatePerSecond * elapsed)) / WAD;
  return p.totalReserves + (interest * p.reserveFactor) / WAD;
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

/** Lifetime totals from events, in the pool's asset units. */
export type PoolEvents = { flashFees: bigint; reservesWithdrawn: bigint; badDebtAbsorbed: bigint };

export type PoolRevenue = {
  /** pToken symbol (pMUSD) and its asset's price symbol (MUSD). */
  label: string;
  asset: string;
  pool: Address;
  decimals: number;
  /** WAD share of interest kept as reserves. */
  reserveFactor: bigint;
  /** As stored at the last accrual, and accrued up to the report block. */
  totalReserves: bigint;
  accruedReserves: bigint;
  cash: bigint;
  /** What `withdrawReserves` can take now: min(accrued reserves, idle cash). */
  withdrawable: bigint;
  /** USD per whole asset unit at the last known oracle price (display only), null without a price. */
  price: number | null;
  events: PoolEvents | null;
};

export type CollateralKind = 'share' | 'plain' | 'remote';

export type TreasuryHolding = {
  id: number;
  label: string;
  kind: CollateralKind;
  /** Hub token (pToken or plain token); null for remote collateral. */
  token: Address | null;
  /** Wormhole chain id and spoke token of remote collateral. */
  chainId: number | null;
  remoteToken: Address | null;
  /** Collateral units the treasury holds in custody (pToken shares for share collateral). */
  balance: bigint;
  balanceDecimals: number;
  /** The same in the priced asset (pToken shares converted to assets). */
  assets: bigint;
  assetDecimals: number;
  asset: string;
  /**
   * Shares the pool's idle cash could redeem now (share collateral only), after the withdrawal of that pool's
   * withdrawable reserves: both draw on the same cash, and the collection plan takes the reserves first.
   */
  redeemable: bigint | null;
  /** That idle cash in the pool's asset: the pool's cash less the plan's reserve withdrawal (share collateral only). */
  cashLeft: bigint | null;
  usd: number | null;
  /** Lifetime units taken as the protocol fee (LiquidationFeeTaken), whoever was treasury then. */
  feesTaken: bigint | null;
};

export type RevenueReport = {
  network: NetworkName;
  blockNumber: bigint;
  timestamp: bigint;
  vaultManager: Address;
  adapter: Address;
  owner: Address;
  treasury: Address;
  liquidationFeeBps: number;
  /** Treasury account's debt in USD (WAD, last known prices): withdrawals then need prices and the borrow limit. */
  treasuryDebtValue: bigint;
  /** Wormhole fee a remote withdrawal pays (msg.value). */
  messageFee: bigint;
  pools: PoolRevenue[];
  holdings: TreasuryHolding[];
  /** Block range the event totals cover; null when the scan was skipped. */
  scanned: { fromBlock: bigint; toBlock: bigint } | null;
};

export type RevenueTarget = {
  network: NetworkName;
  deployment: HubDeployment;
  client: PublicClient;
  /** Spoke deployments, to name remote collateral. */
  spokes: { network: NetworkName; deployment: SpokeDeployment }[];
};

export type ReadOptions = { events: boolean; fromBlock?: bigint };

const REVENUE_EVENTS = [
  getAbiItem({ abi: vaultManagerAbi, name: 'LiquidationFeeTaken' }),
  getAbiItem({ abi: pTokenAbi, name: 'FlashLoan' }),
  getAbiItem({ abi: pTokenAbi, name: 'ReservesWithdrawn' }),
  getAbiItem({ abi: pTokenAbi, name: 'BadDebtWrittenOff' }),
] as const;

/** USD value of `amount` (in `decimals` units) at a WAD price; display only. */
const usdOf = (amount: bigint, decimals: number, price: number | null): number | null =>
  price === null ? null : Number(formatUnits(amount, decimals)) * price;
const addressOf = (word: Hex): Address => getAddress(`0x${word.slice(-40)}`);

/** Reads the revenue state of a hub at its latest block. */
export async function readRevenue(target: RevenueTarget, opts: ReadOptions): Promise<RevenueReport> {
  const { client, deployment, network } = target;
  const vm = deployment.contracts.vaultManager;
  const block = await client.getBlock();
  const blockNumber = block.number;
  const at = { blockNumber } as const;
  const readVm = <F extends 'owner' | 'treasury' | 'liquidationFeeBps' | 'marketCount' | 'collateralCount' | 'adapter'>(functionName: F) =>
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName, ...at });

  const [owner, treasury, liquidationFeeBps, marketCount, collateralCount, adapter] = await Promise.all([
    readVm('owner'),
    readVm('treasury'),
    readVm('liquidationFeeBps'),
    readVm('marketCount'),
    readVm('collateralCount'),
    readVm('adapter'),
  ]);
  const prices = new Map<Hex, Promise<number | null>>();
  const priceOf = (key: Hex): Promise<number | null> => {
    if (!prices.has(key)) {
      prices.set(
        key,
        client.readContract({ address: deployment.contracts.oracleRouter, abi: oracleRouterAbi, functionName: 'getPriceUnsafe', args: [key], ...at }).then(
          ([price]) => (price === 0n ? null : Number(formatUnits(price, 18))),
          () => null,
        ),
      );
    }
    return prices.get(key)!;
  };

  const markets = await Promise.all(
    Array.from({ length: Number(marketCount) }, (_, id) =>
      client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'markets', args: [BigInt(id)], ...at }),
    ),
  );
  const pools: PoolRevenue[] = await Promise.all(
    markets.map(async (m) => {
      const readPool = <F extends 'symbol' | 'reserveFactor' | 'totalReserves' | 'totalBorrows' | 'accrualTimestamp' | 'borrowRatePerSecond' | 'cash'>(
        functionName: F,
      ) => client.readContract({ address: m.pool, abi: pTokenAbi, functionName, ...at });
      const [label, reserveFactor, totalReserves, totalBorrows, accrualTimestamp, borrowRatePerSecond, cash, price] = await Promise.all([
        readPool('symbol'),
        readPool('reserveFactor'),
        readPool('totalReserves'),
        readPool('totalBorrows'),
        readPool('accrualTimestamp'),
        readPool('borrowRatePerSecond'),
        readPool('cash'),
        priceOf(m.priceKey),
      ]);
      const accrued = accruedReserves({ totalBorrows, totalReserves, reserveFactor, borrowRatePerSecond, accrualTimestamp }, block.timestamp);
      return {
        label,
        asset: symbolForPriceKey(m.priceKey) ?? label,
        pool: m.pool,
        decimals: m.decimals,
        reserveFactor,
        totalReserves,
        accruedReserves: accrued,
        cash,
        withdrawable: accrued < cash ? accrued : cash,
        price,
        events: null,
      };
    }),
  );

  const remoteLabels = new Map<string, string>();
  for (const s of target.spokes) {
    for (const [symbol, token] of Object.entries(s.deployment.tokens))
      remoteLabels.set(`${s.deployment.wormholeChainId}:${token.toLowerCase()}`, `${s.network} ${symbol}`);
  }
  const hubTokens = new Map(Object.entries(deployment.tokens).map(([symbol, token]) => [String(token).toLowerCase(), symbol]));

  const holdings: TreasuryHolding[] = await Promise.all(
    Array.from({ length: Number(collateralCount) }, async (_, id): Promise<TreasuryHolding> => {
      const [c, balance] = await Promise.all([
        client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collaterals', args: [BigInt(id)], ...at }),
        client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'collateralBalance', args: [treasury, BigInt(id)], ...at }),
      ]);
      const asset = symbolForPriceKey(c.priceKey) ?? 'units';
      const price = await priceOf(c.priceKey);
      if (c.isRemote) {
        const remoteToken = addressOf(c.remoteToken);
        return {
          id,
          label: remoteLabels.get(`${c.chainId}:${remoteToken.toLowerCase()}`) ?? `chain ${c.chainId} ${remoteToken}`,
          kind: 'remote',
          token: null,
          chainId: c.chainId,
          remoteToken,
          balance,
          balanceDecimals: c.decimals,
          assets: balance,
          assetDecimals: c.decimals,
          asset,
          redeemable: null,
          cashLeft: null,
          usd: usdOf(balance, c.decimals, price),
          feesTaken: null,
        };
      }
      if (!c.isShare) {
        return {
          id,
          label: hubTokens.get(c.token.toLowerCase()) ?? c.token,
          kind: 'plain',
          token: c.token,
          chainId: null,
          remoteToken: null,
          balance,
          balanceDecimals: c.decimals,
          assets: balance,
          assetDecimals: c.decimals,
          asset,
          redeemable: null,
          cashLeft: null,
          usd: usdOf(balance, c.decimals, price),
          feesTaken: null,
        };
      }
      const readShare = <F extends 'symbol' | 'decimals' | 'cash'>(functionName: F) =>
        client.readContract({ address: c.token, abi: pTokenAbi, functionName, ...at });
      const [label, shareDecimals, cash] = await Promise.all([readShare('symbol'), readShare('decimals'), readShare('cash')]);
      // PToken.maxRedeem is bounded by idle cash, which withdrawReserves spends first (same block, same cash).
      const reserveStep = pools.find((p) => isAddressEqual(p.pool, c.token))?.withdrawable ?? 0n;
      const cashLeft = cash > reserveStep ? cash - reserveStep : 0n;
      const [assets, cashShares] = await Promise.all([
        client.readContract({ address: c.token, abi: pTokenAbi, functionName: 'convertToAssets', args: [balance], ...at }),
        client.readContract({ address: c.token, abi: pTokenAbi, functionName: 'convertToShares', args: [cashLeft], ...at }),
      ]);
      return {
        id,
        label,
        kind: 'share',
        token: c.token,
        chainId: null,
        remoteToken: null,
        balance,
        balanceDecimals: shareDecimals,
        assets,
        assetDecimals: c.decimals,
        asset,
        redeemable: balance < cashShares ? balance : cashShares,
        cashLeft,
        usd: usdOf(assets, c.decimals, price),
        feesTaken: null,
      };
    }),
  );

  const [snapshot, messageFee] = await Promise.all([
    client.readContract({ address: vm, abi: vaultManagerAbi, functionName: 'getRiskSnapshot', args: [treasury], ...at }),
    client.readContract({ address: adapter, abi: wormholeAdapterAbi, functionName: 'messageFee', ...at }),
  ]);

  let scanned: RevenueReport['scanned'] = null;
  if (opts.events) {
    const fromBlock = opts.fromBlock ?? BigInt(deployment.startBlock);
    const logs = await getLogsChunked(
      fromBlock,
      blockNumber,
      ({ fromBlock: from, toBlock: to }) =>
        client.getLogs({ address: [vm, ...pools.map((p) => p.pool)], events: REVENUE_EVENTS, fromBlock: from, toBlock: to }),
      NETWORKS[network]?.maxLogRange,
    );
    for (const p of pools) p.events = { flashFees: 0n, reservesWithdrawn: 0n, badDebtAbsorbed: 0n };
    for (const h of holdings) h.feesTaken = 0n;
    for (const log of logs) {
      if (log.eventName === 'LiquidationFeeTaken') {
        if (!isAddressEqual(log.address, vm)) continue;
        const h = holdings[Number(log.args.collateralId)];
        if (h) h.feesTaken = (h.feesTaken ?? 0n) + (log.args.amount ?? 0n);
        continue;
      }
      const pool = pools.find((p) => isAddressEqual(p.pool, log.address));
      if (!pool?.events) continue;
      if (log.eventName === 'FlashLoan') pool.events.flashFees += log.args.fee ?? 0n;
      else if (log.eventName === 'ReservesWithdrawn') pool.events.reservesWithdrawn += log.args.amount ?? 0n;
      else if (log.eventName === 'BadDebtWrittenOff') pool.events.badDebtAbsorbed += log.args.fromReserves ?? 0n;
    }
    scanned = { fromBlock, toBlock: blockNumber };
  }

  return {
    network,
    blockNumber,
    timestamp: block.timestamp,
    vaultManager: vm,
    adapter,
    owner,
    treasury,
    liquidationFeeBps,
    treasuryDebtValue: snapshot.debtValue,
    messageFee,
    pools,
    holdings,
    scanned,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Collection plan
// ---------------------------------------------------------------------------------------------------------------

export type PlanStep = { signer: 'owner' | 'treasury'; what: string; command: string };
export type CollectionPlan = { steps: PlanStep[]; notes: string[] };

/** Shell variables the printed commands expect: the hub RPC URL and the signer's keystore (never printed here). */
const SIGN = '--rpc-url "$RPC" --keystore "$KEYSTORE"';
const BPS = 10_000n;
/**
 * Room the idle cash must leave over the treasury's shares for the plan to redeem them all: interest raises the
 * share price until the transaction lands (0.1% is hours of interest even at a full pool's rate).
 */
const REDEEM_ROOM_BPS = 10n;

/**
 * The transactions that collect everything collectable now, to `to` (default: the treasury itself), in order: reserves
 * capped by idle cash (owner), the treasury's local custody balances (BTC, and pTokens taken out as far as the idle
 * cash left after those reserves allows) and its spoke collateral through a RELEASE (treasury).
 */
export function collectionPlan(r: RevenueReport, to: Address = r.treasury): CollectionPlan {
  const steps: PlanStep[] = [];
  const notes: string[] = [];
  for (const p of r.pools) {
    if (p.withdrawable > 0n) {
      steps.push({
        signer: 'owner',
        what: `withdraw ${formatUnits(p.withdrawable, p.decimals)} ${p.asset} of ${p.label} reserves`,
        command: `cast send ${p.pool} "withdrawReserves(uint256,address)" ${p.withdrawable} ${to} ${SIGN}`,
      });
    }
    if (p.accruedReserves > p.cash) {
      notes.push(`${p.label}: reserves exceed idle cash; the rest becomes withdrawable as borrowers repay or suppliers deposit`);
    }
  }
  for (const h of r.holdings) {
    if (h.balance === 0n) continue;
    const amount = `${formatUnits(h.balance, h.balanceDecimals)} ${h.label}`;
    if (h.kind === 'remote') {
      steps.push({
        signer: 'treasury',
        what: `release ${amount} to ${to} on the spoke (collateral #${h.id})`,
        command: `cast send ${r.vaultManager} "withdrawRemote(uint256,uint256,bytes32,bytes[])" ${h.id} ${h.balance} ${pad(to, { size: 32 }).toLowerCase()} "[]" --value ${r.messageFee} ${SIGN}`,
      });
      notes.push(`collateral #${h.id}: the RELEASE pays out once relayed to the spoke (the agent does it; by hand: docs/RUNBOOK.md, section 3)`);
    } else if (h.kind === 'plain') {
      steps.push({
        signer: 'treasury',
        what: `withdraw ${amount} (collateral #${h.id})`,
        command: `cast send ${r.vaultManager} "withdrawCollateral(uint256,uint256,address,bytes[])" ${h.id} ${h.balance} ${to} "[]" ${SIGN}`,
      });
    } else {
      // The treasury withdraws the shares to itself, then takes out what the remaining idle cash covers; the rest keeps earning.
      steps.push({
        signer: 'treasury',
        what: `withdraw ${amount} shares (collateral #${h.id})`,
        command: `cast send ${r.vaultManager} "withdrawCollateral(uint256,uint256,address,bytes[])" ${h.id} ${h.balance} ${r.treasury} "[]" ${SIGN}`,
      });
      const cash = h.cashLeft ?? 0n;
      if (h.assets * (BPS + REDEEM_ROOM_BPS) <= cash * BPS) {
        steps.push({
          signer: 'treasury',
          what: `redeem ${amount} for ${h.asset} (or keep the shares earning)`,
          command: `cast send ${h.token} "redeem(uint256,address,address)" ${h.balance} ${to} ${r.treasury} ${SIGN}`,
        });
      } else if (cash > 0n) {
        // Cash binds (or nearly): PToken caps redeem() at the shares the cash buys at the rate when it lands, which
        // interest raises every second, so a redeem of the shares the cash covers at this block would revert. withdraw()
        // is capped at the cash itself, in assets, which accrual leaves alone.
        const assets = h.assets < cash ? h.assets : cash;
        steps.push({
          signer: 'treasury',
          what: `withdraw ${formatUnits(assets, h.assetDecimals)} ${h.asset} from ${h.label} (or keep the shares earning)`,
          command: `cast send ${h.token} "withdraw(uint256,address,address)" ${assets} ${to} ${r.treasury} ${SIGN}`,
        });
      }
      if (h.assets > cash) {
        const afterReserves = r.pools.some((p) => h.token !== null && isAddressEqual(p.pool, h.token) && p.withdrawable > 0n);
        notes.push(
          `${h.label}: idle cash${afterReserves ? ' left after the reserve withdrawal' : ''} redeems ${cash > 0n ? 'only part of the shares now; the rest stays' : 'none of the shares now; they stay'} redeemable later`,
        );
      }
    }
  }
  if (r.treasuryDebtValue > 0n) {
    notes.push('the treasury account has debt: collateral withdrawals need price updates and must keep it within its borrow limit');
  }
  if (!isAddressEqual(r.owner, r.treasury) && steps.some((s) => s.signer === 'owner') && steps.some((s) => s.signer === 'treasury')) {
    notes.push('reserves are withdrawn by the owner key, custody balances by the treasury key');
  }
  return { steps, notes };
}
