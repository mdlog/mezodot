import { useQuery } from '@tanstack/react-query';
import { usePublicClient } from 'wagmi';
import { isAddressEqual, maxUint256, zeroHash, type Address, type PublicClient } from 'viem';
import {
  pTokenAbi,
  spokeGatewayAbi,
  toBytes32,
  vaultManagerAbi,
  wormholeAdapterAbi,
  type CollateralState,
  type MarketState,
  type PositionState,
} from '@mezodot/sdk';
import { HUB, type SpokeInfo } from '../chain/env';
import { assetsFor } from '../lib/shares';
import { useHubClient, useProtocol } from './hooks';

/**
 * Switches, caps and registrations the contracts enforce, read before an action so it is disabled with its
 * reason instead of failing after the wallet prompt (or, on a spoke, after the wrap and approve have been paid).
 */

// --- Hub: pauses and market switches -------------------------------------------------------------------------

export type HubFlags = {
  /** VaultManager.pause(): blocks new borrows, and with them loops and BTC leverage. */
  vaultPaused: boolean;
  /** Per market id: the pool's own pause (new supply and borrows) and VaultManager's market switch (borrows). */
  markets: Record<number, { poolPaused: boolean; enabled: boolean }>;
};

export async function readHubFlags(client: PublicClient, vaultManager: Address, markets: Pick<MarketState, 'id' | 'pool'>[]): Promise<HubFlags> {
  const [vaultPaused, rows] = await Promise.all([
    client.readContract({ address: vaultManager, abi: vaultManagerAbi, functionName: 'paused' }),
    Promise.all(
      markets.map(async (m) => {
        const [poolPaused, market] = await Promise.all([
          client.readContract({ address: m.pool, abi: pTokenAbi, functionName: 'paused' }),
          client.readContract({ address: vaultManager, abi: vaultManagerAbi, functionName: 'markets', args: [BigInt(m.id)] }),
        ]);
        return [m.id, { poolPaused, enabled: market.enabled }] as const;
      }),
    ),
  ]);
  return { vaultPaused, markets: Object.fromEntries(rows) };
}

export function useHubFlags() {
  const client = useHubClient();
  const protocol = useProtocol().data;
  return useQuery({
    queryKey: ['hubFlags', protocol?.markets.map((m) => m.pool).join(',')],
    enabled: Boolean(client && HUB.deployment && protocol),
    refetchInterval: 30_000,
    queryFn: () => readHubFlags(client!, HUB.deployment!.contracts.vaultManager, protocol!.markets),
  });
}

/** Amount that still fits under a cap (maxUint256 = uncapped). */
const room = (cap: bigint, used: bigint): bigint => (cap === maxUint256 ? maxUint256 : cap > used ? cap - used : 0n);

/** Seconds between reading a pool and the transaction that relies on the read landing on-chain (generous). */
export const INCLUSION_SECONDS = 600n;

type Accrual = Partial<Pick<MarketState, 'borrowRatePerSecond' | 'accrualTimestamp'>> & Pick<MarketState, 'totalBorrows'>;

/**
 * Interest a pool adds to its borrows (and, at most, to its supply) between `since` and a transaction landing
 * INCLUSION_SECONDS from now. MezodotPool accrues before it checks a cap, so a room computed from stored values
 * must leave this much spare or MAX would revert.
 */
export function pendingInterest(m: Accrual, since: bigint | undefined, nowSec = BigInt(Math.floor(Date.now() / 1000))): bigint {
  if (!m.borrowRatePerSecond || m.totalBorrows === 0n) return 0n;
  const elapsed = (since !== undefined && nowSec > since ? nowSec - since : 0n) + INCLUSION_SECONDS;
  return (m.totalBorrows * m.borrowRatePerSecond * elapsed) / 10n ** 18n;
}

/**
 * Underlying the pool still accepts (PToken.maxDeposit without the pause). totalAssets is read with pending interest
 * included, so only the growth until inclusion is held back.
 */
export const supplyRoom = (m: Pick<MarketState, 'supplyCap' | 'totalAssets'> & Partial<Accrual>): bigint =>
  m.supplyCap === maxUint256
    ? maxUint256
    : room(m.supplyCap, m.totalAssets + pendingInterest({ totalBorrows: m.totalBorrows ?? 0n, borrowRatePerSecond: m.borrowRatePerSecond }, undefined));
/** Debt the pool can still lend before its borrow cap (MezodotPool.borrow): stored borrows plus interest since the last accrual. */
export const borrowRoom = (m: Pick<MarketState, 'borrowCap'> & Accrual): bigint =>
  m.borrowCap === maxUint256 ? maxUint256 : room(m.borrowCap, m.totalBorrows + pendingInterest(m, m.accrualTimestamp));
/** Collateral units (pool shares for pTokens, token units otherwise) VaultManager still accepts. */
export const collateralRoom = (c: Pick<CollateralState, 'cap' | 'total'>): bigint => room(c.cap, c.total);

export function supplyBlocked(m: MarketState, flags: HubFlags | undefined): string | null {
  if (flags?.markets[m.id]?.poolPaused) return `The ${m.symbol} pool is paused: new supply is blocked. Withdrawals still work.`;
  if (supplyRoom(m) === 0n) return `The ${m.symbol} pool is full: it has reached its supply cap.`;
  return null;
}

export function borrowBlocked(m: MarketState, flags: HubFlags | undefined): string | null {
  if (flags?.vaultPaused) return 'Borrowing is paused on Mezodot right now. Repaying and withdrawing still work.';
  const market = flags?.markets[m.id];
  if (market?.poolPaused) return `The ${m.symbol} pool is paused: new borrows are blocked. Repaying still works.`;
  if (market && !market.enabled) return `Borrowing ${m.symbol} is switched off right now.`;
  if (borrowRoom(m) === 0n) return `${m.symbol} has reached its borrow cap.`;
  return null;
}

/** Why new collateral of this kind cannot be posted (VaultManager._depositLocal). */
export function postBlocked(c: CollateralState): string | null {
  if (!c.enabled) return `${c.symbol} is not accepted as new collateral right now.`;
  if (collateralRoom(c) === 0n) return `${c.symbol} collateral has reached its cap.`;
  return null;
}

export type RepayWithSharesPlan = {
  /** Debt the call repays: all of it, or what the posted shares are worth when they cover less. */
  repaid: bigint;
  /** Every posted share is burned (they are worth no more than the debt). */
  burnsAll: boolean;
  blocked: string | null;
};

/**
 * VaultManager.repayWithCollateral with amount = max, for debt in `m` and posted shares of its own pool: it repays
 * min(debt, value of the shares) without moving tokens or reading prices, and reverts (WouldLeaveBadDebt) if that
 * would leave debt on the account with no collateral at all.
 */
export function repayWithSharesPlan(
  m: Pick<MarketState, 'id' | 'symbol' | 'exchangeRate' | 'shareDecimals'>,
  share: Pick<CollateralState, 'id' | 'symbol'>,
  position: Pick<PositionState, 'collateral' | 'debts'>,
): RepayWithSharesPlan {
  const debt = position.debts.find((d) => d.marketId === m.id)?.amount ?? 0n;
  const shares = position.collateral.find((c) => c.id === share.id)?.balance ?? 0n;
  const value = assetsFor(m, shares);
  const repaid = debt < value ? debt : value;
  const burnsAll = value <= debt;
  if (debt === 0n) return { repaid: 0n, burnsAll: false, blocked: `No ${m.symbol} debt to repay.` };
  if (shares === 0n) return { repaid: 0n, burnsAll: false, blocked: `No ${share.symbol} posted as collateral.` };
  const debtLeft = debt > repaid || position.debts.some((d) => d.marketId !== m.id && d.amount > 0n);
  const otherCollateral = position.collateral.some((c) => c.id !== share.id && c.balance > 0n);
  if (burnsAll && debtLeft && !otherCollateral) {
    return {
      repaid,
      burnsAll,
      blocked: `Your posted ${share.symbol} is your only collateral and does not cover all your debt: burning it would leave debt with nothing behind it. Repay part of it from your wallet first.`,
    };
  }
  return { repaid, burnsAll, blocked: null };
}

// --- Spokes: gateway state and the hub's registration of the gateway ------------------------------------------

export type SpokeLockState = {
  paused: boolean;
  allowed: boolean;
  cap: bigint;
  locked: bigint;
  /** The gateway addresses its DEPOSITs to the hub adapter this app uses. */
  targetsHub: boolean;
  /** The hub adapter trusts this gateway as the chain's emitter. */
  hubTrustsGateway: boolean;
  /** VaultManager lists (chain, token) as remote collateral. */
  hubListsToken: boolean;
};

export async function readSpokeLockState(spoke: SpokeInfo, spokeClient: PublicClient, hubClient: PublicClient, token: Address): Promise<SpokeLockState> {
  if (!spoke.deployment || !HUB.deployment) throw new Error(`${spoke.label} is not connected to a hub deployment`);
  const gateway = spoke.deployment.contracts.spokeGateway;
  const hub = HUB.deployment.contracts;
  const [paused, [allowed, cap], locked, hubEmitter, spokeEmitter, idPlusOne] = await Promise.all([
    spokeClient.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'paused' }),
    spokeClient.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'tokens', args: [token] }),
    spokeClient.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'locked', args: [token] }),
    spokeClient.readContract({ address: gateway, abi: spokeGatewayAbi, functionName: 'hubEmitter' }),
    hubClient.readContract({ address: hub.wormholeAdapter, abi: wormholeAdapterAbi, functionName: 'spokeEmitter', args: [spoke.wormholeChainId] }),
    hubClient.readContract({
      address: hub.vaultManager,
      abi: vaultManagerAbi,
      functionName: 'remoteCollateralId',
      args: [spoke.wormholeChainId, toBytes32(token)],
    }),
  ]);
  const sameBytes32 = (a: string, address: Address) => a !== zeroHash && isAddressEqual(`0x${a.slice(-40)}`, address) && /^0x0{24}/i.test(a);
  return {
    paused,
    allowed,
    cap,
    locked,
    targetsHub: sameBytes32(hubEmitter, hub.wormholeAdapter),
    hubTrustsGateway: sameBytes32(spokeEmitter, gateway),
    hubListsToken: idPlusOne > 0n,
  };
}

/** Tokens the gateway still accepts before its cap. */
export const lockRoom = (s: Pick<SpokeLockState, 'cap' | 'locked'>): bigint => room(s.cap, s.locked);

/** Why a lock of `amount` would fail or never be credited on the hub; null when it can go ahead. */
export function lockBlocked(s: SpokeLockState, spokeLabel: string, symbol: string, amount = 0n): string | null {
  if (s.paused) return `The ${spokeLabel} gateway is paused: new locks are blocked. Releases still work.`;
  if (!s.allowed) return `${symbol} is not accepted by the ${spokeLabel} gateway.`;
  // A message the hub would reject cannot be refunded on the spoke, so these block the lock outright.
  if (!s.targetsHub || !s.hubTrustsGateway || !s.hubListsToken) {
    return `The ${spokeLabel} gateway is not connected to the Mezo hub right now (configuration in progress); locking now could strand the tokens.`;
  }
  const left = lockRoom(s);
  if (left === 0n) return `The ${spokeLabel} gateway has reached its ${symbol} cap.`;
  if (amount > left) return `That is more ${symbol} than the ${spokeLabel} gateway still accepts under its cap.`;
  return null;
}

export function useSpokeLockState(spoke: SpokeInfo | undefined, token: Address | undefined) {
  const spokeClient = usePublicClient({ chainId: spoke?.chain.id }) as PublicClient | undefined;
  const hubClient = useHubClient();
  return useQuery({
    queryKey: ['spokeLock', spoke?.name, token],
    enabled: Boolean(spoke?.deployment && token && spokeClient && hubClient && HUB.deployment),
    refetchInterval: 30_000,
    queryFn: () => readSpokeLockState(spoke!, spokeClient!, hubClient!, token!),
  });
}
