import { encodePacked, hexToBigInt, pad, size, sliceHex, type Address, type Hex } from 'viem';

/** Mirrors contracts/src/libraries/Payload.sol (106 bytes, packed). */
export const PAYLOAD_VERSION = 1;
export const MessageType = { DEPOSIT: 1, RELEASE: 2 } as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export type Message = {
  msgType: MessageTypeValue;
  nonce: bigint;
  account: Hex; // bytes32
  token: Hex; // bytes32
  amount: bigint;
};

export const toBytes32 = (address: Address): Hex => pad(address, { size: 32 }).toLowerCase() as Hex;
export const fromBytes32 = (b: Hex): Address => `0x${b.slice(-40)}` as Address;

export const encodePayload = (m: Message): Hex =>
  encodePacked(['uint8', 'uint8', 'uint64', 'bytes32', 'bytes32', 'uint256'], [PAYLOAD_VERSION, m.msgType, m.nonce, m.account, m.token, m.amount]);

export function decodePayload(data: Hex): Message {
  if (size(data) !== 106) throw new Error('Invalid payload length');
  const version = Number(hexToBigInt(sliceHex(data, 0, 1)));
  const msgType = Number(hexToBigInt(sliceHex(data, 1, 2)));
  if (version !== PAYLOAD_VERSION || (msgType !== 1 && msgType !== 2)) throw new Error('Invalid payload');
  return {
    msgType: msgType as MessageTypeValue,
    nonce: hexToBigInt(sliceHex(data, 2, 10)),
    account: sliceHex(data, 10, 42),
    token: sliceHex(data, 42, 74),
    amount: hexToBigInt(sliceHex(data, 74, 106)),
  };
}
