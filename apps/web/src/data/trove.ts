import { erc20Abi, type Address, type PublicClient } from 'viem';
import { CRITICAL_COLLATERAL_RATIO, closeFunding, pTokenAbi, readTrove, type CloseFunding, type HubDeployment, type TroveState } from '@mezodot/sdk';

/** A borrower's trove with the balances that can pay it down. */
export type TroveWallet = {
  trove: TroveState;
  btc: bigint;
  musd: bigint;
  /** pMUSD shares in the wallet. Posted shares must be withdrawn first: only the account can spend them. */
  shares: bigint;
  /** What `shares` redeem for now. */
  supplyAssets: bigint;
};

export async function readTroveWallet(client: PublicClient, hub: HubDeployment, account: Address): Promise<TroveWallet> {
  const { pMUSD } = hub.contracts;
  const [trove, btc, musd, shares] = await Promise.all([
    readTrove(client, hub, account),
    client.getBalance({ address: account }),
    client.readContract({ address: hub.tokens.MUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'balanceOf', args: [account] }),
  ]);
  const supplyAssets = shares === 0n ? 0n : await client.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'convertToAssets', args: [shares] });
  return { trove, btc, musd, shares, supplyAssets };
}

/** Interest keeps accruing until the close lands; the contract refunds whatever this margin leaves over. */
const CLOSE_MARGIN_DIVISOR = 10_000n;

export type ClosePlan = CloseFunding & { shares: bigint };

/** How a close is paid: shares first, rounded up so they cover their part, then wallet MUSD. */
export function closePlan({ debt, shares, supplyAssets, walletMusd }: { debt: bigint; shares: bigint; supplyAssets: bigint; walletMusd: bigint }): ClosePlan {
  const funding = closeFunding({ debt: debt + debt / CLOSE_MARGIN_DIVISOR, supplyAssets, walletMusd });
  if (funding.fromSupply === 0n) return { ...funding, shares: 0n };
  if (funding.fromSupply >= supplyAssets) return { ...funding, shares };
  const rounded = (funding.fromSupply * shares + supplyAssets - 1n) / supplyAssets;
  return { ...funding, shares: rounded < shares ? rounded : shares };
}

/** Why Mezo would refuse to close this trove now, or null. */
export function closeBlocked(t: TroveState): string | null {
  if (t.recoveryMode) return 'Mezo is in Recovery Mode, when troves cannot be closed. You can still repay.';
  const debt = t.systemDebt > t.debt ? t.systemDebt - t.debt : 0n;
  if (debt > 0n) {
    const coll = t.systemColl > t.coll ? t.systemColl - t.coll : 0n;
    if ((coll * t.price) / debt < CRITICAL_COLLATERAL_RATIO)
      return 'Closing would leave the Mezo system below its 150% minimum, so Mezo would refuse it. You can still repay.';
  }
  return null;
}
