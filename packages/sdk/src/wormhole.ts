import { concatHex, decodeEventLog, encodePacked, keccak256, numberToHex, type Address, type Hex, type Log } from 'viem';
import { sign } from 'viem/accounts';
import { wormholeAbi } from './abis';
import { toBytes32 } from './payload';

export type PublishedMessage = {
  emitter: Address;
  sequence: bigint;
  nonce: number;
  payload: Hex;
  consistencyLevel: number;
};

/** Decodes a Wormhole Core `LogMessagePublished` log, or returns null for other logs. */
export function parseLogMessagePublished(log: Pick<Log, 'topics' | 'data'>): PublishedMessage | null {
  try {
    const decoded = decodeEventLog({ abi: wormholeAbi, eventName: 'LogMessagePublished', topics: log.topics as [Hex, ...Hex[]], data: log.data });
    const a = decoded.args;
    return { emitter: a.sender, sequence: a.sequence, nonce: a.nonce, payload: a.payload, consistencyLevel: a.consistencyLevel };
  } catch {
    return null;
  }
}

/**
 * Fetches a guardian-signed VAA from Wormholescan. Returns null while it is not yet available
 * (guardians still observing / finality not reached).
 */
export async function fetchSignedVaa(apiBase: string, chainId: number, emitter: Address, sequence: bigint, fetchImpl: typeof fetch = fetch): Promise<Hex | null> {
  const emitterHex = toBytes32(emitter).slice(2);
  const res = await fetchImpl(`${apiBase}/v1/signed_vaa/${chainId}/${emitterHex}/${sequence}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Wormholescan error ${res.status}`);
  const body = (await res.json()) as { vaaBytes?: string };
  if (!body.vaaBytes) return null;
  const bytes = typeof atob === 'function' ? Uint8Array.from(atob(body.vaaBytes), (c) => c.charCodeAt(0)) : Buffer.from(body.vaaBytes, 'base64');
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
}

/** VAA v1 body: timestamp | nonce | emitterChain | emitter | sequence | consistency | payload. */
export function vaaBody(m: { timestamp: number; nonce: number; emitterChain: number; emitter: Address; sequence: bigint; consistencyLevel: number; payload: Hex }): Hex {
  return encodePacked(
    ['uint32', 'uint32', 'uint16', 'bytes32', 'uint64', 'uint8', 'bytes'],
    [m.timestamp, m.nonce, m.emitterChain, toBytes32(m.emitter), m.sequence, m.consistencyLevel, m.payload],
  );
}

/**
 * Signs a VAA with a single dev guardian key — devnet only (matches DevWormhole / VaaSigner.sol).
 * The guardian signs keccak256(keccak256(body)); the recovery id is stored as 0/1.
 */
export async function signDevVaa(guardianKey: Hex, m: Parameters<typeof vaaBody>[0]): Promise<Hex> {
  const body = vaaBody(m);
  const hash = keccak256(keccak256(body));
  const sig = await sign({ hash, privateKey: guardianKey });
  const recovery = Number(sig.yParity ?? (sig.v !== undefined ? Number(sig.v) - 27 : 0));
  return concatHex([
    numberToHex(1, { size: 1 }), // version
    numberToHex(0, { size: 4 }), // guardian set index
    numberToHex(1, { size: 1 }), // signature count
    numberToHex(0, { size: 1 }), // guardian index
    sig.r,
    sig.s,
    numberToHex(recovery, { size: 1 }),
    body,
  ]);
}
