/**
 * Simulation engine: pure state transitions for the demo account.
 *
 * Each action takes the current `DemoState` and returns either a new state
 * (plus a toast message) or a validation error. Nothing here touches React,
 * the network, or a wallet.
 */
import {
  CHAINS,
  INITIAL_ACCOUNT,
  INITIAL_RATES,
  MARKETS,
  PREVIOUS_RATES,
  PRICES,
  PROTOCOL,
  RECEIPT_OF,
  RESERVE_FACTOR,
  RISK_PARAMS,
  chainOf,
  initialActivity,
  marketOf,
  type Account,
  type Activity,
  type AssetSymbol,
  type ChainId,
  type CollateralAsset,
  type ReceiptSymbol,
} from '../data/mock';
import { fakeTxRef, fmt, fmtHealth, money, uid } from './format';
import {
  accrue,
  assetsForShares,
  availableLiquidity,
  borrowCapacity,
  emission,
  healthFactor,
  liquidationPrice,
  loanToValue,
  planLoop,
  sharesForAssets,
  supplyApy,
  utilization,
  type LoopPlan,
} from './protocol';

export const STATE_VERSION = 2;

export type DemoState = {
  version: number;
  account: Account;
  rates: Record<ReceiptSymbol, number>;
  previousRates: Record<ReceiptSymbol, number>;
  /** Simulated days of interest accrued since the demo started. */
  elapsedDays: number;
  activities: Activity[];
};

export type ActionResult = { ok: true; state: DemoState; message: string } | { ok: false; error: string };

const MAX_ACTIVITIES = 100;
/** Dust below this is treated as zero to avoid float residue after MAX withdrawals. */
const DUST = 1e-9;

export const createInitialState = (now = Date.now()): DemoState => ({
  version: STATE_VERSION,
  account: structuredClone(INITIAL_ACCOUNT),
  rates: { ...INITIAL_RATES },
  previousRates: { ...PREVIOUS_RATES },
  elapsedDays: 0,
  activities: initialActivity(now),
});

/* ------------------------------------------------------------------------- */
/* Derived views                                                             */
/* ------------------------------------------------------------------------- */

export type MarketStats = {
  utilization: number;
  /** Interest-only supply APY (what grows the pToken exchange rate). */
  baseSupplyApy: number;
  /** Base + MEZO rewards. */
  totalSupplyApy: number;
  liquidity: number;
  suppliedUsd: number;
};

export const marketStats = (symbol: AssetSymbol): MarketStats => {
  const m = marketOf(symbol);
  const util = utilization(m.supplied, m.borrowed);
  const base = supplyApy(m.borrowApy, util, RESERVE_FACTOR);
  return {
    utilization: util,
    baseSupplyApy: base,
    totalSupplyApy: base + m.rewardApr,
    liquidity: availableLiquidity(m.supplied, m.borrowed),
    suppliedUsd: m.supplied * PRICES[symbol],
  };
};

export const protocolKpis = () => {
  const poolsUsd = MARKETS.reduce((sum, m) => sum + m.supplied * PRICES[m.symbol], 0);
  return {
    tvl: poolsUsd + PROTOCOL.remoteCollateralUsd,
    crossChainRatio: PROTOCOL.remoteBackedBorrow / marketOf('MUSD').borrowed,
  };
};

export const collateralUsd = (balances: Record<CollateralAsset, number>): number => balances.wETH * PRICES.wETH + balances.USDC * PRICES.USDC;

export type Summary = ReturnType<typeof summarize>;

export const summarize = ({ account, rates }: DemoState) => {
  const remoteByChain = CHAINS.map((chain) => ({
    chain,
    ...account.collateral[chain.id],
    usd: collateralUsd(account.collateral[chain.id]),
  }));
  const remoteCollateral = remoteByChain.reduce((sum, c) => sum + c.usd, 0);
  const totalWeth = remoteByChain.reduce((sum, c) => sum + c.wETH, 0);
  const totalUsdc = remoteByChain.reduce((sum, c) => sum + c.USDC, 0);
  const loopCollateral = assetsForShares(account.loop.shares, rates.pMUSD);
  const collateral = remoteCollateral + loopCollateral;
  const debt = account.debtMUSD + account.loop.debt;
  const earn = {
    MUSD: assetsForShares(account.earnShares.pMUSD, rates.pMUSD),
    MEZO: assetsForShares(account.earnShares.pMEZO, rates.pMEZO),
  };
  const netValue = account.wallet.MUSD + account.wallet.MEZO * PRICES.MEZO + earn.MUSD + earn.MEZO * PRICES.MEZO + collateral - debt;

  return {
    remoteByChain,
    remoteCollateral,
    loopCollateral,
    loopEquity: loopCollateral - account.loop.debt,
    collateral,
    debt,
    ltv: loanToValue(collateral, debt),
    healthFactor: healthFactor(collateral, debt, RISK_PARAMS.liquidationThreshold),
    available: borrowCapacity(collateral, debt, RISK_PARAMS.maxLtv),
    liquidationPriceWeth: liquidationPrice(totalWeth, totalUsdc * PRICES.USDC + loopCollateral, debt, RISK_PARAMS.liquidationThreshold),
    earn,
    netValue,
  };
};

export const loopParams = () => {
  const musd = marketOf('MUSD');
  return {
    supplyApyPct: marketStats('MUSD').totalSupplyApy,
    borrowApyPct: musd.borrowApy,
    maxLtv: RISK_PARAMS.maxLtv,
    liquidationThreshold: RISK_PARAMS.liquidationThreshold,
  };
};

export const previewLoop = (principal: number, leverage: number): LoopPlan => planLoop(principal, leverage, loopParams());

/* ------------------------------------------------------------------------- */
/* Actions                                                                   */
/* ------------------------------------------------------------------------- */

type NewActivity = Omit<Activity, 'id' | 'at' | 'tx' | 'status'> & { status?: Activity['status'] };

const withActivity = (state: DemoState, entry: NewActivity, now = Date.now()): DemoState => ({
  ...state,
  activities: [{ ...entry, status: entry.status ?? 'Simulated', id: uid(), at: now, tx: fakeTxRef() } satisfies Activity, ...state.activities].slice(
    0,
    MAX_ACTIVITIES,
  ),
});

const ok = (state: DemoState, message: string): ActionResult => ({ ok: true, state, message });
const fail = (error: string): ActionResult => ({ ok: false, error });
const clampDust = (n: number) => (Math.abs(n) < DUST ? 0 : n);

export function supply(state: DemoState, asset: AssetSymbol, amount: number): ActionResult {
  const { account } = state;
  if (!(amount > 0)) return fail('Enter a valid amount');
  if (amount > account.wallet[asset]) return fail(`Amount exceeds your simulated ${asset} wallet balance`);
  const receipt = RECEIPT_OF[asset];
  const rate = state.rates[receipt];
  const shares = sharesForAssets(amount, rate);
  const next: DemoState = {
    ...state,
    account: {
      ...account,
      wallet: { ...account.wallet, [asset]: account.wallet[asset] - amount },
      earnShares: { ...account.earnShares, [receipt]: account.earnShares[receipt] + shares },
    },
  };
  return ok(
    withActivity(next, {
      kind: 'Supply',
      asset,
      amount,
      value: amount * PRICES[asset],
      source: 'Wallet',
      destination: `Mezo · ${receipt} Vault`,
      detail: `${fmt(shares, 2)} ${receipt} minted at a simulated ${rate.toFixed(4)} exchange rate.`,
    }),
    `Supplied ${fmt(amount, 2)} ${asset} · ${fmt(shares, 2)} ${receipt} minted`,
  );
}

export function withdraw(state: DemoState, asset: AssetSymbol, amount: number): ActionResult {
  const { account } = state;
  const receipt = RECEIPT_OF[asset];
  const rate = state.rates[receipt];
  const position = assetsForShares(account.earnShares[receipt], rate);
  if (!(amount > 0)) return fail('Enter a valid amount');
  if (amount > position + DUST) return fail(`Amount exceeds your supplied ${asset} position`);
  const burned = Math.min(account.earnShares[receipt], sharesForAssets(amount, rate));
  const next: DemoState = {
    ...state,
    account: {
      ...account,
      wallet: { ...account.wallet, [asset]: account.wallet[asset] + amount },
      earnShares: { ...account.earnShares, [receipt]: clampDust(account.earnShares[receipt] - burned) },
    },
  };
  return ok(
    withActivity(next, {
      kind: 'Withdraw',
      asset,
      amount,
      value: amount * PRICES[asset],
      source: `${receipt} Vault`,
      destination: 'Wallet',
      detail: `${fmt(burned, 2)} ${receipt} redeemed for ${fmt(amount, 2)} ${asset} at ${rate.toFixed(4)}.`,
    }),
    `Withdrew ${fmt(amount, 2)} ${asset}`,
  );
}

export function borrow(state: DemoState, amount: number): ActionResult {
  const before = summarize(state);
  if (!(amount > 0)) return fail('Enter a valid amount');
  if (amount > before.available + DUST) return fail(`Borrow exceeds available collateral capacity (${money(before.available, 2)})`);
  if (amount > marketStats('MUSD').liquidity) return fail('Borrow exceeds MUSD pool liquidity');
  const { account } = state;
  const next: DemoState = {
    ...state,
    account: { ...account, debtMUSD: account.debtMUSD + amount, wallet: { ...account.wallet, MUSD: account.wallet.MUSD + amount } },
  };
  const after = summarize(next);
  return ok(
    withActivity(next, {
      kind: 'Borrow',
      asset: 'MUSD',
      amount,
      value: amount,
      source: 'Mezo Hub',
      destination: 'Wallet',
      detail: `Borrow simulated at ${marketOf('MUSD').borrowApy.toFixed(2)}% APY. Health factor ${fmtHealth(before.healthFactor)} → ${fmtHealth(after.healthFactor)}.`,
    }),
    `Borrowed ${money(amount, 2)} MUSD · health factor ${fmtHealth(after.healthFactor)}`,
  );
}

export function repay(state: DemoState, amount: number): ActionResult {
  const { account } = state;
  if (!(amount > 0)) return fail('Enter a valid amount');
  if (amount > account.debtMUSD + DUST) return fail('Repayment exceeds outstanding MUSD debt');
  if (amount > account.wallet.MUSD) return fail('Amount exceeds your simulated MUSD wallet balance');
  const before = summarize(state);
  const next: DemoState = {
    ...state,
    account: {
      ...account,
      debtMUSD: clampDust(account.debtMUSD - amount),
      wallet: { ...account.wallet, MUSD: account.wallet.MUSD - amount },
    },
  };
  const after = summarize(next);
  return ok(
    withActivity(next, {
      kind: 'Repay',
      asset: 'MUSD',
      amount,
      value: amount,
      source: 'Wallet',
      destination: 'Mezo Hub · Debt',
      detail: `Simulated repayment applied to outstanding MUSD debt. Health factor ${fmtHealth(before.healthFactor)} → ${fmtHealth(after.healthFactor)}.`,
    }),
    `Repaid ${money(amount, 2)} MUSD`,
  );
}

export function validateCollateral(state: DemoState, chain: ChainId, asset: CollateralAsset, amount: number): string | null {
  if (!(amount > 0)) return 'Enter a valid collateral amount';
  if (amount > state.account.spokeWallet[chain][asset] + DUST) return `Amount exceeds your simulated ${asset} balance on ${chainOf(chain).name}`;
  return null;
}

export function postCollateral(state: DemoState, chain: ChainId, asset: CollateralAsset, amount: number): ActionResult {
  const error = validateCollateral(state, chain, asset, amount);
  if (error) return fail(error);
  const { account } = state;
  const name = chainOf(chain).name;
  const next: DemoState = {
    ...state,
    account: {
      ...account,
      spokeWallet: { ...account.spokeWallet, [chain]: { ...account.spokeWallet[chain], [asset]: clampDust(account.spokeWallet[chain][asset] - amount) } },
      collateral: { ...account.collateral, [chain]: { ...account.collateral[chain], [asset]: account.collateral[chain][asset] + amount } },
    },
  };
  return ok(
    withActivity(next, {
      kind: 'Cross-chain',
      asset,
      amount,
      value: amount * PRICES[asset],
      source: `${name} Spoke`,
      destination: 'Mezo Hub',
      detail: `Simulated ${asset} collateral message sent from ${name} via WormholeAdapter. Principal remains locked in the ${name} SpokeGateway.`,
    }),
    `Collateral state received from ${name} · borrow capacity updated`,
  );
}

export function openLoop(state: DemoState, principal: number, leverage: number): ActionResult {
  const plan = previewLoop(principal, leverage);
  if (plan.error) return fail(plan.error);
  const { account } = state;
  if (principal > account.wallet.MUSD) return fail('Amount exceeds your simulated MUSD wallet balance');
  if (plan.debt > marketStats('MUSD').liquidity) return fail('Loop exceeds MUSD pool liquidity');
  const shares = sharesForAssets(plan.gross, state.rates.pMUSD);
  const next: DemoState = {
    ...state,
    account: {
      ...account,
      wallet: { ...account.wallet, MUSD: account.wallet.MUSD - principal },
      loop: { shares: account.loop.shares + shares, debt: account.loop.debt + plan.debt, principal: account.loop.principal + principal },
    },
  };
  const after = summarize(next);
  return ok(
    withActivity(next, {
      kind: 'Loop',
      asset: 'MUSD',
      amount: plan.gross,
      value: plan.gross,
      source: 'LeverageManager',
      destination: 'Mezo · pMUSD Vault',
      detail: `${money(principal)} equity at ${leverage}×: flash borrow ${money(plan.debt)} → supply ${money(plan.gross)} → borrow ${money(plan.debt)} → repay flash, in one simulated transaction. Account health factor now ${fmtHealth(after.healthFactor)}.`,
    }),
    'Loop simulation complete · nothing was sent on-chain',
  );
}

export function closeLoop(state: DemoState): ActionResult {
  const { account } = state;
  if (account.loop.shares <= 0) return fail('No open loop position');
  const value = assetsForShares(account.loop.shares, state.rates.pMUSD);
  const equity = value - account.loop.debt;
  if (equity < 0) return fail('Loop is under water and cannot be unwound in this demo');
  // The remaining Hub debt must still be covered by remote collateral alone.
  const remote = summarize(state).remoteCollateral;
  if (account.debtMUSD > remote * RISK_PARAMS.maxLtv + DUST)
    return fail('Repay part of your Hub borrow first — remote collateral alone would exceed the max LTV');
  const next: DemoState = {
    ...state,
    account: { ...account, wallet: { ...account.wallet, MUSD: account.wallet.MUSD + equity }, loop: { shares: 0, debt: 0, principal: 0 } },
  };
  return ok(
    withActivity(next, {
      kind: 'Loop',
      asset: 'MUSD',
      amount: equity,
      value: equity,
      source: 'Mezo · pMUSD Vault',
      destination: 'Wallet',
      detail: `Loop unwound: ${money(value, 2)} pMUSD redeemed, ${money(account.loop.debt, 2)} debt repaid via flash route, ${money(equity, 2)} MUSD equity returned.`,
    }),
    `Loop closed · ${money(equity, 2)} MUSD returned to wallet`,
  );
}

/**
 * Fast-forwards time: pToken rates grow at the base supply APY, debts grow at
 * the borrow APY and MEZO rewards are paid to the wallet.
 */
export function accrueInterest(state: DemoState, days: number): ActionResult {
  if (!(days > 0)) return fail('Enter a valid number of days');
  const before = summarize(state);
  const musd = marketOf('MUSD');
  const mezo = marketOf('MEZO');
  const rates = {
    pMUSD: accrue(state.rates.pMUSD, marketStats('MUSD').baseSupplyApy, days),
    pMEZO: accrue(state.rates.pMEZO, marketStats('MEZO').baseSupplyApy, days),
  };
  const { account } = state;
  const rewardsUsd = emission(before.earn.MUSD + before.loopCollateral, musd.rewardApr, days) + emission(before.earn.MEZO * PRICES.MEZO, mezo.rewardApr, days);
  const rewardsMezo = rewardsUsd / PRICES.MEZO;
  const next: DemoState = {
    ...state,
    rates,
    previousRates: state.rates,
    elapsedDays: state.elapsedDays + days,
    account: {
      ...account,
      wallet: { ...account.wallet, MEZO: account.wallet.MEZO + rewardsMezo },
      debtMUSD: accrue(account.debtMUSD, musd.borrowApy, days),
      loop: { ...account.loop, debt: accrue(account.loop.debt, musd.borrowApy, days) },
    },
  };
  const after = summarize(next);
  return ok(
    withActivity(next, {
      kind: 'Interest',
      asset: 'MEZO',
      amount: rewardsMezo,
      value: rewardsUsd,
      source: 'MezodotPool',
      destination: 'Wallet',
      detail: `${days} simulated days: pMUSD ${state.rates.pMUSD.toFixed(4)} → ${rates.pMUSD.toFixed(4)}, pMEZO ${state.rates.pMEZO.toFixed(4)} → ${rates.pMEZO.toFixed(4)}. Debt ${money(before.debt, 2)} → ${money(after.debt, 2)}. ${fmt(rewardsMezo, 2)} MEZO rewards paid. Net account value ${money(before.netValue, 2)} → ${money(after.netValue, 2)}.`,
    }),
    `${days} days accrued · pMUSD rate ${rates.pMUSD.toFixed(4)}`,
  );
}

export function agentDryRun(state: DemoState, kind: 'Liquidation' | 'Rebalance'): ActionResult {
  const amount = kind === 'Liquidation' ? 1_540 : 840;
  return ok(
    withActivity(state, {
      kind,
      asset: 'MUSD',
      amount,
      value: amount,
      source: 'KeeperGateway',
      destination: 'Mezo Hub',
      detail: `Keeper ${kind.toLowerCase()} dry-run generated locally. No agent, contract, or transaction was invoked.`,
    }),
    `${kind} dry-run complete · local simulation only`,
  );
}
