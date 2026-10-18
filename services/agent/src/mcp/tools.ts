import { formatUnits, getAddress, isAddress, maxUint256, parseUnits, type Address } from 'viem';
import {
  BPS,
  liquidatorShare,
  marketPoolState,
  perSecondToApy,
  planBtcClose,
  planBtcLeverage,
  planLoop,
  positionSymbols,
  readPosition,
  readProtocol,
  riskCheckSymbols,
  symbolForPriceKey,
  valuePosition,
  type BtcCloseTerms,
  type CollateralState,
  type ProtocolState,
} from '@mezodot/sdk';
import { quoteTigris } from '../dex';
import { evaluateAccount } from '../liquidator';
import type { Services } from '../services';

/**
 * MCP tool handlers as plain async functions (the MCP server wires them up; tests call them
 * directly). Write tools default to dry-run and only execute with MCP_ALLOW_WRITE=true, in the agent itself
 * (over its HTTP /mcp): the stdio server never executes them.
 */

const addr = (raw: string): Address => {
  if (!isAddress(raw)) throw new Error(`Invalid address: ${raw}`);
  return getAddress(raw);
};

/** Plain-token collateral (BTC) the VaultManager cap still accepts, in token units; undefined when uncapped. */
const collateralRoomUnits = (c: CollateralState): number | undefined =>
  c.cap === maxUint256 ? undefined : Number(c.cap > c.total ? c.cap - c.total : 0n) / 10 ** c.decimals;

/** Slippage the BTC previews accept by default (1%). */
const DEFAULT_SLIPPAGE_BPS = 100;

/** Decimals of a collateral balance as VaultManager stores it: pToken shares, else the token's own. */
export function collateralDecimals(protocol: ProtocolState, c: CollateralState): number {
  if (!c.isShare) return c.decimals;
  return protocol.markets.find((m) => m.pool.toLowerCase() === c.token.toLowerCase())?.shareDecimals ?? c.decimals;
}

export function describeMarkets(protocol: ProtocolState) {
  return protocol.markets.map((m) => {
    const util = m.totalAssets > 0n ? Number(m.totalBorrows) / Number(m.totalAssets) : 0;
    return {
      market: m.symbol,
      receipt: m.receiptSymbol,
      marketId: m.id,
      pool: m.pool,
      totalSupplied: formatUnits(m.totalAssets, m.decimals),
      totalBorrowed: formatUnits(m.totalBorrows, m.decimals),
      availableLiquidity: formatUnits(m.cash, m.decimals),
      utilization: util,
      borrowApy: perSecondToApy(m.borrowRatePerSecond),
      supplyApy: perSecondToApy(m.supplyRatePerSecond),
      exchangeRate: formatUnits(m.exchangeRate, m.decimals),
      /** Share of borrower interest kept by the protocol. */
      reserveFactor: Number(m.reserveFactor) / 1e18,
      /** Protocol reserves held by the pool (interest share plus flash fees). */
      totalReserves: formatUnits(m.totalReserves, m.decimals),
    };
  });
}

export function describeCollaterals(protocol: ProtocolState) {
  return protocol.collaterals.map((c) => {
    const decimals = collateralDecimals(protocol, c);
    // The protocol keeps liquidationFeeBps of the bonus: a liquidator nets bonus × (1 − fee) of the repaid value.
    const toLiquidator = liquidatorShare(1 + c.bonusBps / BPS, c.bonusBps, protocol.liquidationFeeBps).toLiquidator;
    return {
      collateralId: c.id,
      symbol: c.symbol,
      location: c.isRemote ? `spoke (wormhole chain ${c.chainId})` : 'hub',
      kind: c.isRemote ? 'remote' : c.isShare ? 'pToken' : 'token',
      priceFeed: symbolForPriceKey(c.priceKey),
      ltv: c.ltvBps / 10_000,
      liquidationThreshold: c.ltBps / 10_000,
      /** Gross bonus on the repaid value. */
      liquidationBonus: c.bonusBps / 10_000,
      /** What a liquidator keeps after the protocol's share of the bonus. */
      liquidatorBonus: toLiquidator - 1,
      enabled: c.enabled,
      /** Most that can be posted in total (null: unlimited, type(uint256).max on-chain). */
      cap: c.cap === maxUint256 ? null : formatUnits(c.cap, decimals),
      totalPosted: formatUnits(c.total, decimals),
    };
  });
}

export type ToolOptions = {
  /** Whether write tools may execute (dry_run=false). Decided by the transport: see http.ts / server.ts (stdio). */
  allowWrite: boolean;
  /** Why they may not, when allowWrite is false (default: the HTTP rule, MCP_ALLOW_WRITE and MCP_TOKEN). */
  writesOff?: string;
};

const HTTP_WRITES_OFF = 'writes disabled (MCP_ALLOW_WRITE=true, and MCP_TOKEN over HTTP)';

export function createTools(s: Services, opts: ToolOptions) {
  const { ctx } = s;
  const writesOff = opts.writesOff ?? HTTP_WRITES_OFF;
  const protocol = () => readProtocol(ctx.hub.client, ctx.hub.deployment);

  /** What the Tigris MUSD/BTC pool pays for `amount` of `from` (pair.getAmountOut, as SwapLeverageManager checks). */
  const quote = (from: Address, to: Address, amount: bigint): Promise<bigint> => quoteTigris(ctx.hub, from, to, amount);

  /** BTC collateral and the MUSD market, with the prices a transaction sent now would see. */
  const btcContext = async (p: ProtocolState) => {
    const btc = p.collaterals.find((c) => !c.isShare && !c.isRemote && symbolForPriceKey(c.priceKey) === 'BTC');
    const musd = p.markets.find((m) => m.symbol === 'MUSD');
    if (!btc || !musd) throw new Error('BTC collateral or the MUSD market is not configured on this hub');
    const { prices, unpriced } = await s.oracle.pricing(['MUSD', 'BTC']);
    if (unpriced.length > 0) throw new Error(`No acceptable price for ${unpriced.join(', ')} right now`);
    return { btc, musd, btcPrice: prices.BTC!, musdPrice: prices.MUSD! };
  };

  /** Token units of a whole-unit amount (at most 12 decimals of it: beyond that a double carries only noise). */
  const toUnits = (amount: number, decimals: number): bigint => parseUnits(amount.toFixed(Math.min(decimals, 12)), decimals);

  return {
    async get_markets() {
      const p = await protocol();
      return {
        markets: describeMarkets(p),
        collaterals: describeCollaterals(p),
        keepers: p.keeperCount,
        liquidationFeeBps: p.liquidationFeeBps,
        treasury: p.treasury,
      };
    },

    async get_position({ address }: { address: string }) {
      const account = addr(address);
      const p = await protocol();
      const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
      // Price everything the account holds, as a transaction sent now would see it.
      const { prices, unpriced } = await s.oracle.pricing(positionSymbols(p, position));
      const evaluation = evaluateAccount(p, position, prices);
      const valued = valuePosition(p, position, prices);
      const collaterals = describeCollaterals(p);
      return {
        account,
        healthFactor: Number.isFinite(evaluation.healthFactor) ? evaluation.healthFactor : null,
        collateralUsd: evaluation.collateralUsd,
        debtUsd: evaluation.debtUsd,
        collateral: position.collateral
          .filter((c) => c.balance > 0n)
          .map((c) => {
            const config = p.collaterals[c.id];
            const row = valued.collateral.find((r) => r.collateral.id === c.id);
            return {
              ...collaterals[c.id],
              /** As VaultManager stores it: pToken shares, else token units. */
              balance: formatUnits(c.balance, collateralDecimals(p, config)),
              /** Underlying token units (pTokens through the exchange rate). */
              units: row?.units ?? null,
              valueUsd: row?.valueUsd ?? null,
            };
          }),
        debts: position.debts
          .filter((d) => d.amount > 0n)
          .map((d) => ({ market: p.markets[d.marketId].symbol, amount: formatUnits(d.amount, p.markets[d.marketId].decimals) })),
        liquidation: evaluation.plan,
        pricesUsed: prices,
        unpriced,
      };
    },

    async get_oracle_health() {
      const status = s.watchdog.status();
      // A missing or stale report is checked again (the oracle loop may not run in this process).
      const report =
        status.report && !status.stale
          ? status.report
          : await s.watchdog.refresh().catch((err: unknown) => {
              if (status.report) return status.report;
              throw err;
            });
      const now = s.watchdog.status();
      return { ...report, stale: now.stale, ageSec: now.ageSec, error: now.error };
    },

    async get_risk_report() {
      return s.risk.report() ?? (await s.risk.refresh()) ?? { error: s.risk.lastError() ?? 'Risk report not available yet' };
    },

    async get_revenue() {
      return s.revenue.report() ?? (await s.revenue.refresh());
    },

    /**
     * LeverageManager.loop preview priced at the state the loop leaves the MUSD pool in (its supply and debt share
     * the pool), against plain supply, within the pool's idle cash and caps; with `address`, the whole account's
     * borrow check and health after the loop.
     */
    async simulate_loop({ principal, leverage, address }: { principal: number; leverage: number; address?: string }) {
      const p = await protocol();
      const musd = p.markets.find((m) => m.symbol === 'MUSD');
      const collateral = p.collaterals.find((c) => c.symbol === 'pMUSD');
      if (!musd || !collateral) throw new Error('MUSD market not configured');
      let account: ReturnType<typeof valuePosition> | undefined;
      let musdPrice: number;
      if (address) {
        const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, addr(address));
        const { prices } = await s.oracle.pricing(riskCheckSymbols(p, position, 'MUSD'));
        account = valuePosition(p, position, prices);
        musdPrice = prices.MUSD ?? 0;
      } else {
        // The loop's borrow is priced strictly: without a usable MUSD price the preview must say it would revert.
        musdPrice = (await s.oracle.pricing(['MUSD'])).prices.MUSD ?? 0;
      }
      // pMUSD shares the cap still accepts, converted to MUSD through the exchange rate (undefined: uncapped).
      const roomShares = collateral.cap === maxUint256 ? undefined : collateral.cap > collateral.total ? collateral.cap - collateral.total : 0n;
      const room = roomShares === undefined ? undefined : Number((roomShares * musd.exchangeRate) / 10n ** BigInt(musd.shareDecimals)) / 10 ** musd.decimals;
      return planLoop(principal, leverage, {
        ltvBps: collateral.ltvBps,
        ltBps: collateral.ltBps,
        supplyApy: perSecondToApy(musd.supplyRatePerSecond),
        borrowApy: perSecondToApy(musd.borrowRatePerSecond),
        pool: marketPoolState(musd) ?? undefined,
        account,
        musdPrice,
        collateralRoom: room,
      });
    },

    /**
     * SwapLeverageManager.open preview with a live Tigris quote: `principal` BTC to `leverage`×, the MUSD pool's
     * idle cash and caps, and (with `address`) the whole account's borrow check.
     */
    async simulate_btc_leverage({
      principal,
      leverage,
      slippage_bps,
      address,
    }: {
      principal: number;
      leverage: number;
      slippage_bps?: number;
      address?: string;
    }) {
      const p = await protocol();
      const { btc, musd, btcPrice, musdPrice } = await btcContext(p);
      const slippageBps = slippage_bps ?? DEFAULT_SLIPPAGE_BPS;
      const borrowMusd = musdPrice > 0 ? (principal * btcPrice * (leverage - 1)) / musdPrice : 0;
      const bought = await quote(musd.asset, btc.token, toUnits(borrowMusd, musd.decimals));
      const quotedBtc = Number(bought) / 10 ** btc.decimals;
      const back = await quote(btc.token, musd.asset, bought).catch(() => null);
      let account: (ReturnType<typeof valuePosition> & { btcUnits: number }) | undefined;
      if (address) {
        const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, addr(address));
        const { prices } = await s.oracle.pricing(riskCheckSymbols(p, position, 'MUSD'));
        const valued = valuePosition(p, position, prices);
        account = { ...valued, btcUnits: valued.collateral.find((r) => r.collateral.id === btc.id)?.units ?? 0 };
      }
      const plan = planBtcLeverage({
        principal,
        leverage,
        btcPrice,
        musdPrice,
        ltvBps: btc.ltvBps,
        ltBps: btc.ltBps,
        quotedBtc,
        slippageBps,
        quotedBackMusd: back === null ? undefined : Number(back) / 10 ** musd.decimals,
        pool: marketPoolState(musd) ?? undefined,
        borrowApy: perSecondToApy(musd.borrowRatePerSecond),
        account,
        collateralRoom: collateralRoomUnits(btc),
      });
      const warnings = [
        plan.warning,
        ...(ctx.hub.deployment.contracts.swapLeverageManager ? [] : ['BTC leverage is not deployed on this hub']),
        ...(btc.enabled ? [] : ['BTC collateral is disabled']),
      ].filter((w): w is string => w !== null);
      return {
        plan: { ...plan, accountAfter: plan.accountAfter ?? undefined },
        quote: { borrowMusd, quotedBtc, oracleBtc: btcPrice > 0 ? (borrowMusd * musdPrice) / btcPrice : 0, priceImpact: plan.priceImpact },
        pricesUsed: { BTC: btcPrice, MUSD: musdPrice },
        liquidity: { musdIdleCash: formatUnits(musd.cash, musd.decimals) },
        warnings,
      };
    },

    /** SwapLeverageManager.close preview for an account's whole BTC position, priced at live Tigris quotes. */
    async simulate_btc_close({ address, slippage_bps }: { address: string; slippage_bps?: number }) {
      const account = addr(address);
      const p = await protocol();
      const { btc, musd, btcPrice, musdPrice } = await btcContext(p);
      const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
      const collateral = position.collateral.find((c) => c.id === btc.id)?.balance ?? 0n;
      const debt = position.debts.find((d) => d.marketId === musd.id)?.amount ?? 0n;
      if (collateral === 0n) return { account, error: 'The account has no BTC collateral posted' };
      const slippageBps = slippage_bps ?? DEFAULT_SLIPPAGE_BPS;
      // Debt in other markets must stay covered once all the BTC leaves, and its risk check needs prices.
      let rest: BtcCloseTerms['rest'];
      if (position.debts.some((d) => d.marketId !== musd.id && d.amount > 0n)) {
        const { prices } = await s.oracle.pricing(riskCheckSymbols(p, position));
        const valued = valuePosition(p, position, prices);
        const musdDebt = valued.debts.find((d) => d.market.id === musd.id)?.valueUsd ?? 0;
        const btcRow = valued.collateral.find((r) => r.collateral.id === btc.id);
        rest = {
          debtUsd: valued.debtUsd - musdDebt,
          // The BTC's share of the limit: only while it is enabled and priced (VaultManager's conservative mode).
          borrowLimitUsd: valued.borrowLimitUsd - (btc.enabled && btcRow?.priced ? (btcRow.valueUsd * btc.ltvBps) / BPS : 0),
          debtPriced: valued.debts.every((d) => d.market.id === musd.id || d.amount === 0n || d.priced),
        };
      }
      const terms: BtcCloseTerms = {
        collateralBtc: Number(collateral) / 10 ** btc.decimals,
        debtMusd: Number(debt) / 10 ** musd.decimals,
        quotedMusdForAll: Number(await quote(btc.token, musd.asset, collateral)) / 10 ** musd.decimals,
        slippageBps,
        btcPrice,
        musdPrice,
        rest,
      };
      // Second pass: size the sale at the average price of the amount actually sold.
      const first = planBtcClose(terms);
      const sell = toUnits(first.sellBtc, btc.decimals);
      const refined =
        sell > 0n
          ? planBtcClose({ ...terms, quote: { sellBtc: first.sellBtc, musd: Number(await quote(btc.token, musd.asset, sell)) / 10 ** musd.decimals } })
          : first;
      const warnings = [
        refined.warning,
        refined.error,
        ...(position.isSwapLeverageOperator ? [] : ['Approve SwapLeverageManager first: VaultManager.setOperator(swapLeverageManager, true)']),
      ].filter((w): w is string => w !== null);
      return {
        account,
        collateralBtc: terms.collateralBtc,
        debtMusd: terms.debtMusd,
        plan: refined,
        quote: { quotedMusdForAll: terms.quotedMusdForAll, oracleMusdForAll: musdPrice > 0 ? (terms.collateralBtc * btcPrice) / musdPrice : null },
        pricesUsed: { BTC: btcPrice, MUSD: musdPrice },
        warnings,
      };
    },

    async simulate_borrow({ address, market, amount }: { address: string; market: string; amount: number }) {
      const account = addr(address);
      const p = await protocol();
      const m = p.markets.find((x) => x.symbol === market.toUpperCase());
      if (!m) throw new Error(`Unknown market ${market}`);
      const position = await readPosition(ctx.hub.client, ctx.hub.deployment, p, account);
      const priceSymbol = symbolForPriceKey(m.priceKey);
      const { prices, unpriced } = await s.oracle.pricing(riskCheckSymbols(p, position, priceSymbol));
      const current = evaluateAccount(p, position, prices);
      const debtPrice = priceSymbol ? prices[priceSymbol] : undefined;
      const addedUsd = amount * (debtPrice ?? 0);
      const debtAfterUsd = current.debtUsd + addedUsd;
      const healthFactorAfter = debtAfterUsd > 0 ? current.adjustedUsd / debtAfterUsd : null;
      // Debt is priced strictly: without a price for every debt asset the borrow reverts.
      const debtUnpriced = unpriced.filter((u) => u === priceSymbol || p.markets.some((x) => symbolForPriceKey(x.priceKey) === u));
      return {
        allowed: debtUnpriced.length === 0 && debtAfterUsd <= current.borrowLimitUsd,
        unpriced,
        healthFactorBefore: Number.isFinite(current.healthFactor) ? current.healthFactor : null,
        healthFactorAfter,
        borrowLimitUsd: current.borrowLimitUsd,
        debtAfterUsd,
      };
    },

    async list_liquidatable() {
      // The liquidator loop evaluates every borrower each tick: answer from it while it is fresh.
      const fresh = s.liquidator.isFresh(4 * ctx.config.pollMs);
      const evaluations = fresh ? s.liquidator.lastEvaluations : (await s.liquidator.evaluateAll()).evaluations;
      return evaluations
        .filter((e) => e.plan)
        .map((e) => ({
          account: e.account,
          healthFactor: e.healthFactor,
          plan: e.plan,
          assessment: s.liquidator.lastAssessments.get(e.account.toLowerCase()) ?? null,
        }));
    },

    async list_pending_messages() {
      const now = Date.now();
      return s.relayer.pending().map(({ vaa: _vaa, ...m }) => ({ ...m, stuck: s.relayer.isStuck(m, now) }));
    },

    async trigger_liquidation({ address, dry_run = true, force = false }: { address: string; dry_run?: boolean; force?: boolean }) {
      const account = addr(address);
      const { protocol: p, evaluation: e, prices } = await s.liquidator.evaluateOne(account);
      if (e.unpriced.length > 0) {
        return { executed: false, reason: `No acceptable price for ${e.unpriced.join(', ')}: a liquidation would revert`, healthFactor: e.healthFactor };
      }
      if (!e.plan) return { executed: false, reason: 'Account is not liquidatable (or the keeper holds none of its debt asset)', healthFactor: e.healthFactor };
      if (!ctx.hub.wallet) return { executed: false, reason: 'No keeper key configured; returning plan only', plan: e.plan };
      const updates = await s.liquidator.updatesFor(e);
      // The pair the keeper loop would send: the best one it can realise, not only the best at oracle prices.
      const { plan, assessment } = await s.liquidator.choose(p, e, prices, updates);
      if (!force && assessment.action === 'skip') {
        return { executed: false, reason: `${assessment.reason} (pass force=true to override)`, plan, assessment };
      }
      const execute = !dry_run && opts.allowWrite;
      const result = await s.liquidator.execute(p, e, updates, !execute, { assessment, prices, plan });
      return {
        executed: execute,
        reason: execute ? 'sent' : dry_run ? 'dry run (pass dry_run=false to execute)' : writesOff,
        plan,
        assessment,
        simulatedSeize: result.simulated,
        seized: result.seized,
        txHash: result.txHash,
      };
    },

    async relay_message({ id, dry_run = true }: { id: string; dry_run?: boolean }) {
      const m = s.relayer.messages().find((x) => x.id === id);
      if (!m) throw new Error(`Unknown message ${id}`);
      if (dry_run || !opts.allowWrite) {
        const { vaa: _vaa, ...rest } = m;
        return { executed: false, reason: dry_run ? 'dry run' : writesOff, message: rest };
      }
      const relayed = await s.relayer.relay(id);
      const { vaa: _vaa, ...before } = m;
      if (!relayed)
        return { executed: false, reason: 'archived as undeliverable: it is addressed to another deployment (see the archived state file)', message: before };
      const { vaa: _after, ...after } = relayed;
      return { executed: true, message: after };
    },
  };
}

export type Tools = ReturnType<typeof createTools>;
