import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, type Abi, type Hex } from 'viem';
import {
  keeperGatewayAbi,
  leverageManagerAbi,
  oracleRouterAbi,
  pTokenAbi,
  spokeGatewayAbi,
  symbolForPriceKey,
  vaultManagerAbi,
  wormholeAdapterAbi,
} from '@mezodot/sdk';

const FRIENDLY: Record<string, string> = {
  InsufficientCollateral: 'This would exceed your borrow limit',
  InsufficientBalance: 'Not enough collateral posted',
  InsufficientCash: 'Not enough liquidity in the pool',
  PositionHealthy: 'Position is healthy — nothing to liquidate',
  SlippageExceeded: 'Price moved; try again',
  NotOperator: 'Approve LeverageManager as operator first',
  CapExceeded: 'Collateral cap reached',
  BorrowCapExceeded: 'Market borrow cap reached',
  NothingToRepay: 'No debt to repay',
  InvalidLeverage: 'Choose a leverage above 1×',
  TokenNotAllowed: 'Token not accepted on this spoke',
  WrongFee: 'Wormhole fee changed; retry',
  AlreadyConsumed: 'Message already delivered',
  EnforcedPause: 'Protocol is paused for new borrows',
  InvalidRecipient: 'Recipient must be an EVM address',
  InsufficientFee: 'Oracle fee changed; retry',
};

/** Errors of every Mezodot contract: reverts bubble up from callees (OracleRouter inside VaultManager). */
const ERRORS = [vaultManagerAbi, oracleRouterAbi, pTokenAbi, leverageManagerAbi, keeperGatewayAbi, wormholeAdapterAbi, spokeGatewayAbi]
  .flat()
  .filter((x) => x.type === 'error') as Abi;

function decode(revert: ContractFunctionRevertedError): { errorName: string; args: readonly unknown[] } | null {
  if (revert.data) return { errorName: revert.data.errorName, args: revert.data.args ?? [] };
  if (!revert.raw) return null;
  try {
    const d = decodeErrorResult({ abi: ERRORS, data: revert.raw as Hex });
    return { errorName: d.errorName, args: d.args ?? [] };
  } catch {
    return null;
  }
}

function describe(errorName: string, args: readonly unknown[]): string {
  const symbol = typeof args[0] === 'string' ? (symbolForPriceKey(args[0] as Hex) ?? 'Oracle') : 'Oracle';
  if (errorName === 'PriceUnavailable') return `${symbol} price is unavailable right now (stale or too uncertain) — retry shortly`;
  if (errorName === 'PriceDiverged') return `${symbol} price sources disagree right now — retry shortly`;
  return FRIENDLY[errorName] ?? errorName;
}

/** Turns wallet / revert errors into one readable sentence. */
export function explainError(err: unknown): string {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'Transaction rejected in wallet';
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const decoded = revert ? decode(revert) : null;
    if (decoded) return describe(decoded.errorName, decoded.args);
    return err.shortMessage;
  }
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}
