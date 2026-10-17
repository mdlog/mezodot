/**
 * Single source of simulated protocol data.
 *
 * Every number shown in the UI is either declared here or derived from these
 * values by the pure functions in `src/lib/protocol.ts`. Derived values
 * (utilization, supply APY, TVL, ratios) are never hard-coded so the scenario
 * stays internally consistent.
 */

export type AssetSymbol = 'MUSD' | 'MEZO';
export type ReceiptSymbol = 'pMUSD' | 'pMEZO';
export type ChainId = 'arbitrum' | 'ethereum';
export type CollateralAsset = 'wETH' | 'USDC';

export const RECEIPT_OF: Record<AssetSymbol, ReceiptSymbol> = { MUSD: 'pMUSD', MEZO: 'pMEZO' };

/** Share of borrower interest kept by the protocol instead of paid to suppliers. */
export const RESERVE_FACTOR = 0.1;

/** Hub-wide risk parameters enforced by VaultManager (same for every collateral type in this demo). */
export const RISK_PARAMS = {
  maxLtv: 0.7,
  liquidationThreshold: 0.8,
} as const;

export const PRICES: Record<AssetSymbol | CollateralAsset, number> = {
  MUSD: 1,
  MEZO: 4.8,
  wETH: 3_200,
  USDC: 1,
};

export type Market = {
  symbol: AssetSymbol;
  receipt: ReceiptSymbol;
  name: string;
  kind: string;
  /** Pool size in underlying tokens (not USD). */
  supplied: number;
  /** Outstanding borrows in underlying tokens (not USD). */
  borrowed: number;
  /** Variable borrow rate, percent. */
  borrowApy: number;
  /** MEZO liquidity incentive paid to suppliers on top of base interest, percent. */
  rewardApr: number;
  color: string;
  icon: string;
};

export const MARKETS: Market[] = [
  {
    symbol: 'MUSD',
    receipt: 'pMUSD',
    name: 'Mezo USD',
    kind: 'Stablecoin',
    supplied: 24_600_000,
    borrowed: 15_006_000,
    borrowApy: 5.2,
    rewardApr: 4.5,
    color: '#5b52ce',
    icon: 'M',
  },
  {
    symbol: 'MEZO',
    receipt: 'pMEZO',
    name: 'Mezo',
    kind: 'Native asset',
    supplied: 2_500_000,
    borrowed: 1_100_000,
    borrowApy: 6.82,
    rewardApr: 1.2,
    color: '#b97b48',
    icon: 'M',
  },
];

export const marketOf = (symbol: AssetSymbol): Market => MARKETS.find((m) => m.symbol === symbol)!;

/** ERC-4626 style exchange rates (underlying per share) at the start of the demo. */
export const INITIAL_RATES: Record<ReceiptSymbol, number> = { pMUSD: 1.0201, pMEZO: 1.0842 };
export const PREVIOUS_RATES: Record<ReceiptSymbol, number> = { pMUSD: 1.0198, pMEZO: 1.0837 };

export const PROTOCOL = {
  name: 'Mezodot Protocol',
  network: 'Mezo Testnet',
  environment: 'Simulated test environment',
  snapshot: 'Block 8,420,114',
  /** USD value of collateral posted on external Spokes (counts toward TVL). */
  remoteCollateralUsd: 9_500_000,
  /** MUSD borrowed against that remote collateral. */
  remoteBackedBorrow: 3_900_000,
  loopVolume: 8_420_000,
  activeAgents: 18,
  tvlDailyChange: 3.82,
  loopVolumeChange: 8.1,
  crossChainChange: 2.14,
  demoAddress: '0x7a…91c4',
} as const;

export type Chain = { id: ChainId; name: string; short: string; color: string };

export const CHAINS: Chain[] = [
  { id: 'arbitrum', name: 'Arbitrum', short: 'A', color: '#3d66ad' },
  { id: 'ethereum', name: 'Ethereum', short: 'E', color: '#6b77bc' },
];

export const chainOf = (id: ChainId): Chain => CHAINS.find((c) => c.id === id)!;

export const AGENTS = {
  keeperStatus: 'Monitoring',
  liquidations24h: 3,
  rebalances24h: 12,
  riskAlerts24h: 2,
  endpoint: 'mcp://mezodot/keeper-gateway',
  methods: [
    { method: 'triggerLiquidation', contract: 'KeeperGateway' },
    { method: 'rebalanceSpoke', contract: 'WormholeAdapter' },
    { method: 'getRiskSnapshot', contract: 'VaultManager' },
  ],
} as const;

export const RISK_METRICS = {
  dsr: 0.78,
  dsrThreshold: 0.7,
  volatility30d: 4.82,
  walkForwardSharpe: 1.34,
  walkForwardWindows: 12,
  walkForwardSeries: [42, 38, 49, 41, 58, 53, 67, 63, 59, 74, 81],
  maxDrawdown: 6.8,
  confidence: 92.1,
} as const;

export const SPARKLINE = [29, 35, 33, 42, 38, 49, 45, 54, 50, 64, 61, 73, 69, 82];

/* ------------------------------------------------------------------------- */
/* Demo account                                                              */
/* ------------------------------------------------------------------------- */

type PerChain<T> = Record<ChainId, T>;
type CollateralBalances = Record<CollateralAsset, number>;

export type Account = {
  wallet: Record<AssetSymbol, number>;
  /** pToken shares held as yield positions (not used as collateral). */
  earnShares: Record<ReceiptSymbol, number>;
  /** Tokens still in the user's wallet on each Spoke, available to post. */
  spokeWallet: PerChain<CollateralBalances>;
  /** Collateral locked in each SpokeGateway, accounted for on the Hub. */
  collateral: PerChain<CollateralBalances>;
  /** MUSD borrowed directly on the Hub. */
  debtMUSD: number;
  /** Leveraged pMUSD position opened by LeverageManager. */
  loop: { shares: number; debt: number; principal: number };
};

/** LP scenario: 10,000 MUSD supplied at the current 1.0201 rate. */
export const LP_DEPOSIT = 10_000;

export const INITIAL_ACCOUNT: Account = {
  wallet: { MUSD: 12_450, MEZO: 1_800 },
  earnShares: { pMUSD: LP_DEPOSIT / INITIAL_RATES.pMUSD, pMEZO: 0 },
  spokeWallet: {
    arbitrum: { wETH: 1.82, USDC: 8_240 },
    ethereum: { wETH: 0.95, USDC: 3_500 },
  },
  collateral: {
    arbitrum: { wETH: 2.4, USDC: 0 },
    ethereum: { wETH: 0, USDC: 0 },
  },
  debtMUSD: 3_120,
  loop: { shares: 0, debt: 0, principal: 0 },
};

/* ------------------------------------------------------------------------- */
/* Activity                                                                  */
/* ------------------------------------------------------------------------- */

export const ACTIVITY_KINDS = ['Supply', 'Withdraw', 'Cross-chain', 'Borrow', 'Repay', 'Loop', 'Interest', 'Liquidation', 'Rebalance'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type Activity = {
  id: string;
  kind: ActivityKind;
  asset: string;
  amount: number;
  /** USD value at the time of the event. */
  value: number;
  source: string;
  destination: string;
  status: 'Simulated' | 'Processing';
  /** Epoch milliseconds. */
  at: number;
  tx: string;
  detail: string;
};

const HOUR = 3_600_000;

export function initialActivity(now = Date.now()): Activity[] {
  const collateralValue = INITIAL_ACCOUNT.collateral.arbitrum.wETH * PRICES.wETH;
  const ltv = INITIAL_ACCOUNT.debtMUSD / collateralValue;
  const shares = INITIAL_ACCOUNT.earnShares.pMUSD;
  return [
    {
      id: 'act-01',
      kind: 'Supply',
      asset: 'MUSD',
      amount: LP_DEPOSIT,
      value: LP_DEPOSIT,
      source: 'Wallet',
      destination: 'Mezo · pMUSD Vault',
      status: 'Simulated',
      at: now - 2 * HOUR,
      tx: '0x7a3e…9c12',
      detail: `${LP_DEPOSIT.toLocaleString('en-US')} MUSD supplied; ${shares.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pMUSD minted at the simulated ${INITIAL_RATES.pMUSD.toFixed(4)} exchange rate.`,
    },
    {
      id: 'act-02',
      kind: 'Cross-chain',
      asset: 'wETH',
      amount: INITIAL_ACCOUNT.collateral.arbitrum.wETH,
      value: collateralValue,
      source: 'Arbitrum Spoke',
      destination: 'Mezo Hub',
      status: 'Simulated',
      at: now - 5 * HOUR,
      tx: '0x2bd1…a80f',
      detail: 'Simulated Wormhole message accepted by VaultManager. Collateral remains on Arbitrum.',
    },
    {
      id: 'act-03',
      kind: 'Borrow',
      asset: 'MUSD',
      amount: INITIAL_ACCOUNT.debtMUSD,
      value: INITIAL_ACCOUNT.debtMUSD,
      source: 'Mezo Hub',
      destination: 'Wallet',
      status: 'Simulated',
      at: now - 5 * HOUR + 60_000,
      tx: '0x6d8f…c341',
      detail: `MUSD borrowed against remote wETH collateral. Simulated LTV after borrow: ${(ltv * 100).toFixed(1)}%.`,
    },
    {
      id: 'act-04',
      kind: 'Rebalance',
      asset: 'MUSD',
      amount: 840,
      value: 840,
      source: 'MUSD Pool',
      destination: 'Mezo Hub',
      status: 'Simulated',
      at: now - 8 * HOUR,
      tx: '0x89c0…4b7e',
      detail: 'KeeperGateway simulated a liquidity rebalance between lending pools.',
    },
    {
      id: 'act-05',
      kind: 'Supply',
      asset: 'MEZO',
      amount: 240,
      value: 240 * PRICES.MEZO,
      source: 'Wallet',
      destination: 'Mezo · pMEZO Vault',
      status: 'Simulated',
      at: now - 26 * HOUR,
      tx: '0xb115…7f04',
      detail: 'Sample record for pMEZO vault activity. This is demo history, not a live transaction.',
    },
    {
      id: 'act-06',
      kind: 'Liquidation',
      asset: 'MUSD',
      amount: 1_540,
      value: 1_540,
      source: 'KeeperGateway',
      destination: 'Mezo Hub',
      status: 'Simulated',
      at: now - 30 * HOUR,
      tx: '0x34af…e9a2',
      detail: 'Historical sample of a keeper liquidation event for the demo activity feed.',
    },
  ];
}
