import { encodePacked, hexToBigInt, pad, size, sliceHex, type Address, type Hex } from 'viem';

/**
 * Mirrors contracts/src/libraries/Payload.sol, version 2 (140 bytes, packed):
 * version | msgType | nonce | targetChain | target | account | token | amount
 * `targetChain` + `target` name the only contract allowed to execute the message.
 */
export const PAYLOAD_VERSION = 2;
export const PAYLOAD_LENGTH = 140;
export const MessageType = { DEPOSIT: 1, RELEASE: 2 } as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export type Message = {
  msgType: MessageTypeValue;
  nonce: bigint;
  /** Wormhole chain id of the destination contract. */
  targetChain: number;
  /** Destination contract (bytes32 universal address). */
  target: Hex;
  account: Hex; // bytes32
  token: Hex; // bytes32
  amount: bigint;
};

export const toBytes32 = (address: Address): Hex => pad(address, { size: 32 }).toLowerCase() as Hex;
export const fromBytes32 = (b: Hex): Address => `0x${b.slice(-40)}` as Address;

/** True when `b` is a left-padded EVM address (what the contracts accept as a recipient). */
export const isEvmAddressBytes32 = (b: Hex): boolean => size(b) === 32 && /^0x0{24}/i.test(b);

export const encodePayload = (m: Message): Hex =>
  encodePacked(
    ['uint8', 'uint8', 'uint64', 'uint16', 'bytes32', 'bytes32', 'bytes32', 'uint256'],
    [PAYLOAD_VERSION, m.msgType, m.nonce, m.targetChain, m.target, m.account, m.token, m.amount],
  );

export function decodePayload(data: Hex): Message {
  if (size(data) !== PAYLOAD_LENGTH) throw new Error('Invalid payload length');
  const version = Number(hexToBigInt(sliceHex(data, 0, 1)));
  const msgType = Number(hexToBigInt(sliceHex(data, 1, 2)));
  if (version !== PAYLOAD_VERSION || (msgType !== 1 && msgType !== 2)) throw new Error('Invalid payload');
  return {
    msgType: msgType as MessageTypeValue,
    nonce: hexToBigInt(sliceHex(data, 2, 10)),
    targetChain: Number(hexToBigInt(sliceHex(data, 10, 12))),
    target: sliceHex(data, 12, 44),
    account: sliceHex(data, 44, 76),
    token: sliceHex(data, 76, 108),
    amount: hexToBigInt(sliceHex(data, 108, 140)),
  };
}
