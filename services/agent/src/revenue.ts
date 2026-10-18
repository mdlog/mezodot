import { join } from 'node:path';
import { formatUnits, getAbiItem, type Address } from 'viem';
import {
  NETWORKS,
  displayPrices,
  pTokenAbi,
  pTokenUnits,
  readPosition,
  readProtocol,
  symbolForPriceKey,
  vaultManagerAbi,
  type ProtocolState,
  type UsdPrices,
} from '@mezodot/sdk';
import type { Context } from './context';
import { publicError } from './errors';
import type { OracleRelay } from './oracle/relay';
import { LogWindow } from './scan';
import { JsonStore, sameAddress } from './store';

/** Lifetime revenue events since the deployment's start block, summed per pool / collateral id. */
type RevenueState = {
  vaultManager: Address | null;
  cursor: bigint | null;
  /** Flash-loan fees per pool (they go straight to reserves). */
  flashFees: Record<string, bigint>;
  /** Reserves the owner withdrew per pool. */
  reservesWithdrawn: Record<string, bigint>;
  /** Bad debt the pool covered from its reserves (MezodotPool.BadDebtWrittenOff.fromReserves), per pool. */
  badDebtFromReserves: Record<string, bigint>;
  /** Collateral units kept as the protocol's share of liquidation bonuses, per collateral id. */
  liquidationFees: Record<string, bigint>;
};

export type RevenueReport = {
  updatedAt: number;
  blockNumber: string;
  treasury: Address;
  /** Protocol share of each liquidation bonus (bps of the bonus). */
  liquidationFeeBps: number;
  markets: {
    market: string;
    pool: Address;
    /** Share of borrower interest kept as reserves. */
    reserveFactor: number;
    /** Current reserves (interest share + flash fees − withdrawals − bad debt covered), in market units. */
    totalReserves: string;
    totalReservesUsd: number | null;
    /** Lifetime flash-loan fees, reserve withdrawals and bad debt absorbed by reserves, from events. */
    flashFees: string;
    reservesWithdrawn: string;
    badDebtFromReserves: string;
  }[];
  liquidationFees: {
    collateralId: number;
    symbol: string;
    /** Lifetime units kept by the protocol (shares for pTokens), from LiquidationFeeTaken events. */
    taken: string;
    takenUsd: number | null;
    /** What the treasury account holds of this collateral in VaultManager custody now. */
    treasuryBalance: string;
    treasuryBalanceUsd: number | null;
  }[];
  totals: { reservesUsd: number; treasuryCollateralUsd: number };
  /** Event scan progress; totals from events cover blocks below it. */
  scannedTo: string | null;
  scanError: string | null;
};

const EVENTS = [
  getAbiItem({ abi: vaultManagerAbi, name: 'LiquidationFeeTaken' }),
  getAbiItem({ abi: pTokenAbi, name: 'FlashLoan' }),
  getAbiItem({ abi: pTokenAbi, name: 'ReservesWithdrawn' }),
  getAbiItem({ abi: pTokenAbi, name: 'BadDebtWrittenOff' }),
] as const;

const add = (m: Record<string, bigint>, key: string, v: bigint) => void (m[key] = (m[key] ?? 0n) + v);
/** eth_getLogs windows per refresh: a long history is caught up over several refreshes (see `scannedTo`). */
const WINDOWS_PER_REFRESH = 50;

/**
 * Protocol revenue as it accrues on-chain: pool reserves (reserve factor on interest plus the 0.09% flash fee),
 * and the treasury's share of liquidation bonuses, credited as collateral in VaultManager custody. Event totals are
 * scanned incrementally (cursor tied to the VaultManager, like the liquidator's index).
 */
export class RevenueTracker {
  readonly store: JsonStore<RevenueState>;
  private readonly window: LogWindow;
  private last: RevenueReport | null = null;
  private refreshing: Promise<RevenueReport> | null = null;
  private scanError: string | null = null;

  constructor(
    private readonly ctx: Context,
    private readonly relay: OracleRelay,
  ) {
    this.store = new JsonStore<RevenueState>(
      join(ctx.config.stateDir, `revenue-${ctx.config.env}.json`),
      { vaultManager: null, cursor: null, flashFees: {}, reservesWithdrawn: {}, badDebtFromReserves: {}, liquidationFees: {} },
      { readOnly: ctx.config.stateReadOnly },
    );
    this.window = new LogWindow(NETWORKS[ctx.hub.network]?.maxLogRange ?? 5_000n);
    const vm = ctx.hub.deployment.contracts.vaultManager;
    if (!sameAddress(this.store.get().vaultManager, vm)) {
      this.store.update((s) => {
        s.vaultManager = vm;
        s.cursor = null;
        s.flashFees = {};
        s.reservesWithdrawn = {};
        s.badDebtFromReserves = {};
        s.liquidationFees = {};
      });
    }
  }

  report(): RevenueReport | null {
    return this.last;
  }

  /** One refresh at a time; concurrent callers share it. */
  refresh(): Promise<RevenueReport> {
    this.refreshing ??= this.build().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async build(): Promise<RevenueReport> {
    const { client, deployment } = this.ctx.hub;
    const protocol = await readProtocol(client, deployment);
    await this.scan(protocol).then(
      () => (this.scanError = null),
      (err: unknown) => {
        this.scanError = publicError(err);
        this.ctx.log('revenue', 'event scan failed; totals cover blocks scanned so far', { error: this.scanError });
      },
    );
    const [treasury, oracle] = await Promise.all([readPosition(client, deployment, protocol, protocol.treasury), this.relay.oracle()]);
    const report = buildRevenueReport(protocol, this.store.get(), treasury.collateral, displayPrices(oracle));
    report.scanError = this.scanError;
    this.last = report;
    return report;
  }

  private async scan(protocol: ProtocolState): Promise<void> {
    const { client, deployment } = this.ctx.hub;
    const vm = deployment.contracts.vaultManager;
    const pools = protocol.markets.map((m) => m.pool);
    const latest = await client.getBlockNumber();
    const fetchLogs = (fromBlock: bigint, toBlock: bigint) => client.getLogs({ address: [vm, ...pools], events: EVENTS, fromBlock, toBlock });
    let from = this.store.get().cursor ?? BigInt(deployment.startBlock);
    for (let windows = 0; from <= latest && windows < WINDOWS_PER_REFRESH; windows++) {
      let to = latest;
      let logs: Awaited<ReturnType<typeof fetchLogs>> = [];
      for (;;) {
        to = from + this.window.size - 1n < latest ? from + this.window.size - 1n : latest;
        try {
          logs = await fetchLogs(from, to);
          this.window.succeeded();
          break;
        } catch (err) {
          if (!this.window.shrink(err)) throw err;
        }
      }
      this.store.update((s) => {
        for (const log of logs) {
          if (log.eventName === 'LiquidationFeeTaken' && sameAddress(log.address, vm)) add(s.liquidationFees, String(log.args.collateralId), log.args.amount!);
          else if (log.eventName === 'FlashLoan') add(s.flashFees, log.address.toLowerCase(), log.args.fee!);
          else if (log.eventName === 'ReservesWithdrawn') add(s.reservesWithdrawn, log.address.toLowerCase(), log.args.amount!);
          else if (log.eventName === 'BadDebtWrittenOff' && !sameAddress(log.address, vm))
            add(s.badDebtFromReserves, log.address.toLowerCase(), log.args.fromReserves!);
        }
        s.cursor = to + 1n;
      });
      from = to + 1n;
    }
  }
}

/** Assembles the revenue report from protocol state, event totals and the treasury's collateral balances. */
export function buildRevenueReport(
  protocol: ProtocolState,
  totals: Pick<RevenueState, 'cursor' | 'flashFees' | 'reservesWithdrawn' | 'liquidationFees'> & Partial<Pick<RevenueState, 'badDebtFromReserves'>>,
  treasuryCollateral: { id: number; balance: bigint }[],
  prices: UsdPrices,
): RevenueReport {
  const priceOf = (key: `0x${string}`) => {
    const s = symbolForPriceKey(key);
    return s ? (prices[s] ?? null) : null;
  };
  /** Collateral units → (formatted, USD); pTokens through the exchange rate. */
  const value = (c: ProtocolState['collaterals'][number], amount: bigint): [string, number | null] => {
    const market = c.isShare ? protocol.markets.find((m) => sameAddress(m.pool, c.token)) : undefined;
    const units = market ? pTokenUnits(market, amount) : Number(amount) / 10 ** c.decimals;
    const price = priceOf(c.priceKey);
    return [formatUnits(amount, market ? market.shareDecimals : c.decimals), price === null ? null : units * price];
  };
  const markets = protocol.markets.map((m) => {
    const price = priceOf(m.priceKey);
    const reserves = Number(m.totalReserves) / 10 ** m.decimals;
    return {
      market: m.symbol,
      pool: m.pool,
      reserveFactor: Number(m.reserveFactor) / 1e18,
      totalReserves: formatUnits(m.totalReserves, m.decimals),
      totalReservesUsd: price === null ? null : reserves * price,
      flashFees: formatUnits(totals.flashFees[m.pool.toLowerCase()] ?? 0n, m.decimals),
      reservesWithdrawn: formatUnits(totals.reservesWithdrawn[m.pool.toLowerCase()] ?? 0n, m.decimals),
      badDebtFromReserves: formatUnits(totals.badDebtFromReserves?.[m.pool.toLowerCase()] ?? 0n, m.decimals),
    };
  });
  const liquidationFees = protocol.collaterals.map((c) => {
    const [taken, takenUsd] = value(c, totals.liquidationFees[String(c.id)] ?? 0n);
    const [treasuryBalance, treasuryBalanceUsd] = value(c, treasuryCollateral.find((x) => x.id === c.id)?.balance ?? 0n);
    return { collateralId: c.id, symbol: c.symbol, taken, takenUsd, treasuryBalance, treasuryBalanceUsd };
  });
  return {
    updatedAt: Date.now(),
    blockNumber: String(protocol.blockNumber),
    treasury: protocol.treasury,
    liquidationFeeBps: protocol.liquidationFeeBps,
    markets,
    liquidationFees,
    totals: {
      reservesUsd: markets.reduce((sum, m) => sum + (m.totalReservesUsd ?? 0), 0),
      treasuryCollateralUsd: liquidationFees.reduce((sum, c) => sum + (c.treasuryBalanceUsd ?? 0), 0),
    },
    scannedTo: totals.cursor === null ? null : String(totals.cursor - 1n),
    scanError: null,
  };
}
