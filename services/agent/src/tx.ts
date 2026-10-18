import { gasWithBuffer } from '@mezodot/sdk';
import type { Hex, PublicClient } from 'viem';
import type { Wallet } from './context';

/**
 * `writeContract` with an explicit gas limit: the node's estimate plus a buffer (see `gasWithBuffer`).
 * Mezo's estimates can be exact to the unit and then run out in the block that executes the transaction.
 */
export async function writeWithBuffer(client: PublicClient, wallet: Wallet, request: object): Promise<Hex> {
  // Loosely typed on purpose: callers pass fully typed writeContract/simulateContract requests, whose viem
  // generics do not survive spreading.
  const estimate = await client.estimateContractGas({ ...request, account: wallet.account } as never);
  return wallet.writeContract({ ...request, gas: gasWithBuffer(estimate) } as never);
}
