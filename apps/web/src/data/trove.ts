import { erc20Abi, parseAbi, type Address, type PublicClient } from 'viem';
import { closeFunding, pTokenAbi, readTrove, troveContracts, vaultManagerAbi, type CloseFunding, type HubDeployment, type TroveState } from '@mezodot/sdk';

const routerCollateralAbi = parseAbi(['function collateralId() view returns (uint256)']);

/** A borrower's trove with the balances that can pay it down. */
export type TroveWallet = {
  trove: TroveState;
  btc: bigint;
  musd: bigint;
  /** pMUSD shares in the wallet. Posted shares must be withdrawn first: only the account can spend them. */
  shares: bigint;
  /** What `shares` redeem for now. */
  supplyAssets: bigint;
  /** What the pMUSD posted as hub collateral redeems for now. */
  postedAssets: bigint;
};

/** The account's pMUSD shares in the hub collateral TroveRouter posts to. */
async function readPostedShares(client: PublicClient, hub: HubDeployment, account: Address): Promise<bigint> {
  const router = troveContracts(hub)?.router;
  if (!router) return 0n;
  const id = await client.readContract({ address: router, abi: routerCollateralAbi, functionName: 'collateralId' });
  return client.readContract({ address: hub.contracts.vaultManager, abi: vaultManagerAbi, functionName: 'collateralBalance', args: [account, id] });
}

export async function readTroveWallet(client: PublicClient, hub: HubDeployment, account: Address): Promise<TroveWallet> {
  const { pMUSD } = hub.contracts;
  const [trove, btc, musd, shares, postedShares] = await Promise.all([
    readTrove(client, hub, account),
    client.getBalance({ address: account }),
    client.readContract({ address: hub.tokens.MUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    client.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'balanceOf', args: [account] }),
    readPostedShares(client, hub, account),
  ]);
  const assetsOf = async (held: bigint) =>
    held === 0n ? 0n : client.readContract({ address: pMUSD, abi: pTokenAbi, functionName: 'convertToAssets', args: [held] });
  const [supplyAssets, postedAssets] = await Promise.all([assetsOf(shares), assetsOf(postedShares)]);
  return { trove, btc, musd, shares, supplyAssets, postedAssets };
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
