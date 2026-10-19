import { tigrisPoolAbi, tigrisRouterAbi } from '@mezodot/sdk';
import type { Address } from 'viem';
import type { HubContext } from './context';
import { sameAddress } from './store';

/**
 * Tigris quote for selling `amount` of `from` for `to` on the volatile pool, in `to` units. The MUSD/BTC pair is
 * quoted on the deployment's `tigrisPool` itself (pair.getAmountOut, what SwapLeverageManager checks); any other
 * pair through the router, whose single-hop getAmountsOut is the same number.
 */
export async function quoteTigris(hub: Pick<HubContext, 'client' | 'deployment'>, from: Address, to: Address, amount: bigint): Promise<bigint> {
  if (amount === 0n) return 0n;
  const { contracts, tokens } = hub.deployment;
  const pair = [tokens.MUSD, tokens.BTC];
  const onPool = contracts.tigrisPool && pair.some((t) => sameAddress(t, from)) && pair.some((t) => sameAddress(t, to)) && !sameAddress(from, to);
  if (onPool) {
    return hub.client.readContract({ address: contracts.tigrisPool!, abi: tigrisPoolAbi, functionName: 'getAmountOut', args: [amount, from] });
  }
  const { tigrisRouter: router, tigrisFactory: factory } = contracts;
  if (!router || !factory) throw new Error('This hub deployment has no Tigris router');
  const amounts = await hub.client.readContract({
    address: router,
    abi: tigrisRouterAbi,
    functionName: 'getAmountsOut',
    args: [amount, [{ from, to, stable: false, factory }]],
  });
  return amounts[amounts.length - 1];
}
