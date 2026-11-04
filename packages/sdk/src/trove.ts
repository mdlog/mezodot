import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import type { HubDeployment } from './deployments';

/**
 * Mezo's MUSD troves, as TroveRouter (contracts/src/hub/TroveRouter.sol) drives them: a trove opened with BTC mints
 * MUSD straight into the Mezodot pool, and supply repays or closes the trove. Mezo authorises a contract to act for
 * a borrower by EIP-712 signature, checked with plain ECDSA, so only EOA keys can use these flows.
 */

export const TROVE_STATUS = { NONE: 0, ACTIVE: 1, CLOSED_BY_OWNER: 2, CLOSED_BY_LIQUIDATION: 3, CLOSED_BY_REDEMPTION: 4 } as const;

const WAD = 10n ** 18n;
/** A trove's debt includes this MUSD, refunded on close, so closing burns only the rest. */
export const GAS_COMPENSATION = 200n * WAD;
/** Debt excluding the gas compensation must stay at or above this. */
export const MIN_NET_DEBT = 1_800n * WAD;
/** A trove below this ratio can be liquidated. */
export const MINIMUM_COLLATERAL_RATIO = (11n * WAD) / 10n;
/** Below this system ratio Mezo is in Recovery Mode; opening must also leave the system at or above it. */
export const CRITICAL_COLLATERAL_RATIO = (15n * WAD) / 10n;

export const troveBorrowerOperationsAbi = parseAbi([
  'function borrowingRate() view returns (uint256)',
  'function redemptionRate() view returns (uint256)',
  'function collSurplusPool() view returns (address)',
  'function interestRateManager() view returns (address)',
  'function claimCollateral()',
]);
export const troveManagerAbi = parseAbi([
  'function getTroveStatus(address) view returns (uint256)',
  'function getEntireDebtAndColl(address) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)',
  'function getTroveMaxBorrowingCapacity(address) view returns (uint256)',
  'function getTCR(uint256) view returns (uint256)',
  'function checkRecoveryMode(uint256) view returns (bool)',
  'function getEntireSystemColl() view returns (uint256)',
  'function getEntireSystemDebt() view returns (uint256)',
]);
const signaturesAbi = parseAbi(['function getNonce(address) view returns (uint256)']);
const priceFeedAbi = parseAbi(['function fetchPrice() view returns (uint256)']);
const hintHelpersAbi = parseAbi(['function getApproxHint(uint256, uint256, uint256) view returns (address, uint256, uint256)']);
const sortedTrovesAbi = parseAbi(['function findInsertPosition(uint256, address, address) view returns (address, address)']);
const collSurplusAbi = parseAbi(['function getCollateral(address) view returns (uint256)']);
const interestRateAbi = parseAbi(['function interestRate() view returns (uint16)']);

// --- Signatures ------------------------------------------------------------------------------------------

export type TroveDomain = { signatures: Address; chainId: number };

const domainOf = ({ signatures, chainId }: TroveDomain) =>
  ({ name: 'BorrowerOperationsSignatures', version: '1', chainId, verifyingContract: signatures }) as const;

const field = <N extends string, T extends string>(name: N, type: T) => ({ name, type }) as const;

export const openTroveTypedData = (
  domain: TroveDomain,
  message: { assetAmount: bigint; debtAmount: bigint; borrower: Address; recipient: Address; nonce: bigint; deadline: bigint },
) => ({
  domain: domainOf(domain),
  primaryType: 'OpenTrove' as const,
  types: {
    OpenTrove: [
      field('assetAmount', 'uint256'),
      field('debtAmount', 'uint256'),
      field('borrower', 'address'),
      field('recipient', 'address'),
      field('nonce', 'uint256'),
      field('deadline', 'uint256'),
    ],
  },
  message,
});

export const repayTroveTypedData = (domain: TroveDomain, message: { amount: bigint; borrower: Address; nonce: bigint; deadline: bigint }) => ({
  domain: domainOf(domain),
  primaryType: 'RepayMUSD' as const,
  types: { RepayMUSD: [field('amount', 'uint256'), field('borrower', 'address'), field('nonce', 'uint256'), field('deadline', 'uint256')] },
  message,
});

export const closeTroveTypedData = (domain: TroveDomain, message: { borrower: Address; recipient: Address; nonce: bigint; deadline: bigint }) => ({
  domain: domainOf(domain),
  primaryType: 'CloseTrove' as const,
  types: { CloseTrove: [field('borrower', 'address'), field('recipient', 'address'), field('nonce', 'uint256'), field('deadline', 'uint256')] },
  message,
});

// --- Previews and limits -------------------------------------------------------------------------------------

export type OpenInput = { btc: bigint; debtAmount: bigint; price: bigint; borrowingRate: bigint; recoveryMode: boolean };

export type OpenPreview = {
  /** Mezo's borrowing fee, added to the debt. Zero in Recovery Mode. */
  fee: bigint;
  /** Debt excluding the gas compensation: what the 1,800 MUSD minimum applies to. */
  netDebt: bigint;
  totalDebt: bigint;
  /** Collateral ratio in WAD (1e18 = 100%). */
  icr: bigint;
  maxBorrowingCapacity: bigint;
  /** BTC price, in WAD, at which the trove's ratio falls to the 110% minimum. */
  liquidationPrice: bigint;
};

export function previewOpenTrove({ btc, debtAmount, price, borrowingRate, recoveryMode }: OpenInput): OpenPreview {
  const fee = recoveryMode ? 0n : (debtAmount * borrowingRate) / WAD;
  const netDebt = debtAmount + fee;
  const totalDebt = netDebt + GAS_COMPENSATION;
  return {
    fee,
    netDebt,
    totalDebt,
    icr: (btc * price) / totalDebt,
    maxBorrowingCapacity: (btc * price) / MINIMUM_COLLATERAL_RATIO,
    liquidationPrice: btc === 0n ? 0n : (totalDebt * MINIMUM_COLLATERAL_RATIO) / btc,
  };
}

const pct = (ratio: bigint) => `${(Number((ratio * 1000n) / WAD) / 10).toFixed(1)}%`;

/** Why Mezo would refuse this open, in words for the borrower; empty when it would accept it. */
export function openBlockers(input: OpenInput & { systemColl: bigint; systemDebt: bigint; status: number; isContract: boolean }): string[] {
  const out: string[] = [];
  if (input.isContract) out.push('This wallet is a smart account. Mezo checks plain ECDSA signatures, so a trove here needs an EOA wallet.');
  if (input.status === TROVE_STATUS.ACTIVE) out.push('This wallet already has an open trove. Mezo allows one per wallet.');
  const p = previewOpenTrove(input);
  if (p.netDebt < MIN_NET_DEBT) out.push('Mezo needs at least 1,800 MUSD of debt, fee included.');
  if (p.icr < MINIMUM_COLLATERAL_RATIO) out.push(`This trove's ratio would be ${pct(p.icr)}. Mezo needs at least 110%.`);
  if (input.recoveryMode && p.icr < CRITICAL_COLLATERAL_RATIO)
    out.push(`Mezo is in Recovery Mode, so a new trove needs at least 150%. This one would be ${pct(p.icr)}.`);
  const newDebt = input.systemDebt + p.totalDebt;
  const newTcr = ((input.systemColl + input.btc) * input.price) / newDebt;
  if (newTcr < CRITICAL_COLLATERAL_RATIO) out.push(`Opening would leave the Mezo system at ${pct(newTcr)}, below its 150% minimum.`);
  return out;
}

/** Most MUSD a repayment can take: the trove must keep the minimum net debt, and only a close clears it. */
export const maxTroveRepay = (debt: bigint): bigint => {
  const floor = GAS_COMPENSATION + MIN_NET_DEBT;
  return debt > floor ? debt - floor : 0n;
};

export type CloseFunding = { needed: bigint; fromSupply: bigint; fromWallet: bigint; shortfall: bigint };

/**
 * MUSD a close burns (debt minus the gas compensation) and where it comes from: supply first, then the wallet.
 * The minted MUSD alone never covers it, because the fee and interest are owed on top.
 */
export function closeFunding({ debt, supplyAssets, walletMusd }: { debt: bigint; supplyAssets: bigint; walletMusd: bigint }): CloseFunding {
  const needed = debt > GAS_COMPENSATION ? debt - GAS_COMPENSATION : 0n;
  const fromSupply = supplyAssets < needed ? supplyAssets : needed;
  const rest = needed - fromSupply;
  const fromWallet = walletMusd < rest ? walletMusd : rest;
  return { needed, fromSupply, fromWallet, shortfall: rest - fromWallet };
}

// --- Chain reads ---------------------------------------------------------------------------------------------

/** The Mezo contracts this needs, or null on a deployment without TroveRouter. */
export function troveContracts(hub: HubDeployment) {
  const c = hub.contracts;
  if (
    !c.troveRouter ||
    !c.mezoBorrowerOperations ||
    !c.mezoBorrowerSignatures ||
    !c.mezoTroveManager ||
    !c.mezoHintHelpers ||
    !c.mezoSortedTroves ||
    !c.mezoPriceFeed
  )
    return null;
  return {
    router: c.troveRouter,
    borrowerOperations: c.mezoBorrowerOperations,
    signatures: c.mezoBorrowerSignatures,
    troveManager: c.mezoTroveManager,
    hintHelpers: c.mezoHintHelpers,
    sortedTroves: c.mezoSortedTroves,
    priceFeed: c.mezoPriceFeed,
  };
}

const required = (hub: HubDeployment) => {
  const c = troveContracts(hub);
  if (!c) throw new Error('TroveRouter is not deployed on this network');
  return c;
};

/** Insert position for a trove of `coll` BTC and `debt` total debt. A stale hint costs gas; it never moves funds. */
export async function findTroveHints(client: PublicClient, hub: HubDeployment, coll: bigint, debt: bigint): Promise<{ upper: Address; lower: Address }> {
  const c = required(hub);
  const nicr = (coll * 10n ** 20n) / debt;
  const [approx] = await client.readContract({ address: c.hintHelpers, abi: hintHelpersAbi, functionName: 'getApproxHint', args: [nicr, 40n, 7n] });
  const [upper, lower] = await client.readContract({
    address: c.sortedTroves,
    abi: sortedTrovesAbi,
    functionName: 'findInsertPosition',
    args: [nicr, approx, approx],
  });
  return { upper, lower };
}

export type TroveState = {
  /** Mezo's BTC price in WAD. */
  price: bigint;
  tcr: bigint;
  recoveryMode: boolean;
  borrowingRate: bigint;
  redemptionRate: bigint;
  /** Mezo's interest on new troves, in basis points a year. */
  interestRateBps: number;
  systemColl: bigint;
  systemDebt: bigint;
  status: number;
  coll: bigint;
  /** Principal plus interest. getEntireDebtAndColl has already folded the pending amounts into both. */
  debt: bigint;
  /** Collateral ratio in WAD; 0 without debt. */
  icr: bigint;
  maxBorrowingCapacity: bigint;
  /** BTC left for the borrower after a redemption or a capped liquidation, waiting to be claimed. */
  surplus: bigint;
  nonce: bigint;
  /** Smart accounts cannot sign for Mezo's ECDSA check. */
  isContract: boolean;
};

export async function readTrove(client: PublicClient, hub: HubDeployment, account: Address): Promise<TroveState> {
  const c = required(hub);
  const tm = { address: c.troveManager, abi: troveManagerAbi } as const;
  const bo = { address: c.borrowerOperations, abi: troveBorrowerOperationsAbi } as const;
  const price = await client.readContract({ address: c.priceFeed, abi: priceFeedAbi, functionName: 'fetchPrice' });
  const surplusPool = hub.contracts.mezoCollSurplusPool ?? (await client.readContract({ ...bo, functionName: 'collSurplusPool' }));
  const rateManager = await client.readContract({ ...bo, functionName: 'interestRateManager' });
  const [
    interestRateBps,
    tcr,
    recoveryMode,
    borrowingRate,
    redemptionRate,
    systemColl,
    systemDebt,
    status,
    position,
    maxBorrowingCapacity,
    surplus,
    nonce,
    code,
  ] = await Promise.all([
    client.readContract({ address: rateManager, abi: interestRateAbi, functionName: 'interestRate' }),
    client.readContract({ ...tm, functionName: 'getTCR', args: [price] }),
    client.readContract({ ...tm, functionName: 'checkRecoveryMode', args: [price] }),
    client.readContract({ ...bo, functionName: 'borrowingRate' }),
    client.readContract({ ...bo, functionName: 'redemptionRate' }),
    client.readContract({ ...tm, functionName: 'getEntireSystemColl' }),
    client.readContract({ ...tm, functionName: 'getEntireSystemDebt' }),
    client.readContract({ ...tm, functionName: 'getTroveStatus', args: [account] }),
    client.readContract({ ...tm, functionName: 'getEntireDebtAndColl', args: [account] }),
    client.readContract({ ...tm, functionName: 'getTroveMaxBorrowingCapacity', args: [account] }),
    client.readContract({ address: surplusPool, abi: collSurplusAbi, functionName: 'getCollateral', args: [account] }),
    client.readContract({ address: c.signatures, abi: signaturesAbi, functionName: 'getNonce', args: [account] }),
    client.getCode({ address: account }),
  ]);
  const [coll, principal, interest] = position;
  const debt = principal + interest;
  return {
    price,
    tcr,
    recoveryMode,
    borrowingRate,
    redemptionRate,
    interestRateBps: Number(interestRateBps),
    systemColl,
    systemDebt,
    status: Number(status),
    coll,
    debt,
    icr: debt === 0n ? 0n : (coll * price) / debt,
    maxBorrowingCapacity,
    surplus,
    nonce,
    isContract: Boolean(code && (code as Hex) !== '0x'),
  };
}
