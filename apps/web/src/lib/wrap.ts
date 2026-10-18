/**
 * SpokeGateway locks ERC-20 tokens only, so native ETH has to be wrapped into WETH first. The deposit
 * flow does that automatically, keeping enough ETH back to pay for wrap + approve + lock.
 */

/** Gas units kept back from native ETH for wrap (~45k), approve (~46k) and lock (~200k), with room to spare. */
export const GAS_RESERVE_UNITS = 600_000n;

/** Floor for the reserve, so a gas-price rise between wrap and lock cannot strand the deposit (0.0005 ETH). */
export const MIN_GAS_RESERVE = 500_000_000_000_000n;

/** WETH a deposit can use: WETH already held plus native ETH beyond the gas reserve at `gasPrice`. */
export function spendableWeth(weth: bigint, native: bigint, gasPrice: bigint): bigint {
  const atPrice = gasPrice * GAS_RESERVE_UNITS;
  const reserve = atPrice > MIN_GAS_RESERVE ? atPrice : MIN_GAS_RESERVE;
  return weth + (native > reserve ? native - reserve : 0n);
}

/** Native ETH to wrap so the wallet holds `amount` WETH (0 when it already does). */
export const wrapNeeded = (weth: bigint, amount: bigint): bigint => (amount > weth ? amount - weth : 0n);

/** WETH9's payable `deposit()`; every WETH on the supported spokes implements it. */
export const wethAbi = [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }] as const;
