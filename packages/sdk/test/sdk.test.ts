import { describe, expect, it } from 'vitest';
import { keccak256, recoverAddress, sliceHex, type Hex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import {
  MessageType,
  RATE_MODELS,
  borrowRate,
  decodePayload,
  encodeMockPythUpdate,
  encodePayload,
  fromBytes32,
  isEvmAddressBytes32,
  blockRanges,
  getLogsChunked,
  fetchPriceUpdate,
  fetchSignedVaa,
  getHubDeployment,
  healthStatus,
  isDeployed,
  parseAmount,
  planLoop,
  seizeAmount,
  signDevVaa,
  summarizePosition,
  supplyRate,
  toBytes32,
  utilization,
  vaaBody,
} from '../src';

// Reference bytes produced by the contracts themselves (see Task 11 notes in the plan ledger).
const SOLIDITY_PAYLOAD =
  '0x020100000000000000070032000000000000000000000000e6e340d132b5f46d1e472debcd681b2abc16e57e000000000000000000000000328809bc894f92807417d2dad6b7c998c1afdac60000000000000000000000004200000000000000000000000000000000000006000000000000000000000000000000000000000000000000214e8348c4f00000';
const HUB_ADAPTER = '0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E';
const MOCK_PYTH_ETH =
  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace0000000000000000000000000000000000000000000000000000004a817c80000000000000000000000000000000000000000000000000000000000005f5e100fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8000000000000000000000000000000000000000000000000000000006553f1000000000000000000000000000000000000000000000000000000004a817c80000000000000000000000000000000000000000000000000000000000005f5e100fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff8000000000000000000000000000000000000000000000000000000006553f100';
const ALICE = '0x328809Bc894f92807417D2dAD6b7C998c1aFdac6';
const BASE_WETH = '0x4200000000000000000000000000000000000006';

describe('math mirrors the contracts', () => {
  it('kinked rate model (InterestRateModel.t.sol)', () => {
    expect(borrowRate(RATE_MODELS.MUSD, 0.4)).toBeCloseTo(0.03, 12); // cash 60, borrows 40
    expect(borrowRate(RATE_MODELS.MUSD, 0.8)).toBeCloseTo(0.06, 12);
    expect(borrowRate(RATE_MODELS.MUSD, 1)).toBeCloseTo(0.86, 12);
    expect(utilization(30, 80, 10)).toBeCloseTo(0.8, 12);
    expect(supplyRate(RATE_MODELS.MUSD, 0.6)).toBeLessThan(borrowRate(RATE_MODELS.MUSD, 0.6) * 0.6);
  });

  it('Arbitrum/Base wETH borrower (VaultManager.t.sol)', () => {
    const s = summarizePosition([{ valueUsd: 7_680, ltvBps: 7_500, ltBps: 8_000 }], 3_120);
    expect(s.borrowLimitUsd).toBe(5_760);
    expect(s.healthFactor).toBeCloseTo(1.969230769, 8);
    expect(s.availableUsd).toBe(2_640);
    expect(summarizePosition([], 0).healthFactor).toBe(Infinity);
  });

  it('PRD flow C loop (LeverageManager.t.sol)', () => {
    const p = planLoop(1_000, 3, { ltvBps: 8_000, ltBps: 8_500, supplyApy: 0.05, borrowApy: 0.04 });
    expect(p.flashAmount).toBe(2_000);
    expect(p.fee).toBeCloseTo(1.8, 12);
    expect(p.debt).toBeCloseTo(2_001.8, 12);
    expect(p.healthFactor).toBeCloseTo((3_000 * 0.85) / 2_001.8, 12);
    expect(p.error).toBeNull();
    expect(p.maxLeverage).toBeCloseTo(5, 12);
    expect(planLoop(1_000, 6, { ltvBps: 8_000, ltBps: 8_500, supplyApy: 0, borrowApy: 0 }).error).toMatch(/max LTV/);
  });

  it('liquidation seize (CrossChain.t.sol: 1,000 MUSD × 1.07 / $2,800)', () => {
    expect(seizeAmount(1_000, 1, 2_800, 700)).toBeCloseTo(1_070 / 2_800, 12);
  });

  it('health status thresholds', () => {
    expect(healthStatus(2).label).toBe('Healthy');
    expect(healthStatus(1.3).label).toBe('Monitor');
    expect(healthStatus(1.05).label).toBe('At risk');
    expect(healthStatus(0.9).label).toBe('Liquidatable');
  });

  it('parses amounts', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-1')).toBeNull();
    expect(parseAmount('2.5')).toBe(2.5);
  });
});

describe('wire formats match Solidity', () => {
  it('payload v2 encodes byte-for-byte like Payload.sol', () => {
    const encoded = encodePayload({
      msgType: MessageType.DEPOSIT,
      nonce: 7n,
      targetChain: 50,
      target: toBytes32(HUB_ADAPTER),
      account: toBytes32(ALICE),
      token: toBytes32(BASE_WETH),
      amount: 2_400_000_000_000_000_000n,
    });
    expect(encoded).toBe(SOLIDITY_PAYLOAD);
    const d = decodePayload(encoded);
    expect(d.nonce).toBe(7n);
    expect(d.targetChain).toBe(50);
    expect(fromBytes32(d.target).toLowerCase()).toBe(HUB_ADAPTER.toLowerCase());
    expect(d.amount).toBe(2_400_000_000_000_000_000n);
    expect(() => decodePayload(sliceHex(encoded, 0, 139))).toThrow();
  });

  it('recognises recipients the spoke can decode', () => {
    expect(isEvmAddressBytes32(toBytes32(ALICE))).toBe(true);
    expect(isEvmAddressBytes32(`0x${ALICE.slice(2)}${'0'.repeat(24)}`)).toBe(false); // right-padded
  });

  it('MockPyth update matches createPriceFeedUpdateData', () => {
    const id = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';
    expect(encodeMockPythUpdate(id, 320_000_000_000n, 100_000_000n, -8, 1_700_000_000n)).toBe(MOCK_PYTH_ETH);
  });

  it('dev VAA is signed by the guardian over keccak(keccak(body))', async () => {
    const key: Hex = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6';
    const m = {
      timestamp: 1_700_000_000,
      nonce: 0,
      emitterChain: 10004,
      emitter: BASE_WETH,
      sequence: 5n,
      consistencyLevel: 1,
      payload: '0xcafe' as Hex,
    } as const;
    const vaa = await signDevVaa(key, m);
    const body = vaaBody(m);
    expect(sliceHex(vaa, 72)).toBe(body); // header(6) + signature(66)
    const r = sliceHex(vaa, 7, 39);
    const s = sliceHex(vaa, 39, 71);
    const v = Number(BigInt(sliceHex(vaa, 71, 72)));
    const signer = await recoverAddress({ hash: keccak256(keccak256(body)), signature: { r, s, yParity: v } });
    expect(signer).toBe(privateKeyToAddress(key));
  });
});

describe('services', () => {
  it('parses a Hermes response', async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          binary: { encoding: 'hex', data: ['abcd'] },
          parsed: [{ id: 'ff61', price: { price: '320000000000', conf: '100000000', expo: -8, publish_time: 1700000000 } }],
        }),
      )) as unknown as typeof fetch;
    const u = await fetchPriceUpdate('http://x', ['0xff61'], fake);
    expect(u.updates).toEqual(['0xabcd']);
    expect(u.prices['0xff61'].price).toBeCloseTo(3_200, 9);
  });

  it('returns null while a VAA is not yet signed', async () => {
    const notFound = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchSignedVaa('http://x', 50, BASE_WETH, 1n, notFound)).toBeNull();
    const found = (async () => new Response(JSON.stringify({ vaaBytes: 'AQID' }))) as unknown as typeof fetch;
    expect(await fetchSignedVaa('http://x', 50, BASE_WETH, 1n, found)).toBe('0x010203');
  });
});

describe('deployments', () => {
  it('devnet is deployed, testnet placeholders are not', () => {
    expect(isDeployed('devnet-hub')).toBe(true);
    expect(getHubDeployment('devnet-hub')?.contracts.vaultManager).toMatch(/^0x/);
    expect(isDeployed('mezo-testnet')).toBe(false);
    expect(getHubDeployment('mezo-testnet')).toBeNull();
  });
});

describe('log chunking', () => {
  it('splits inclusive ranges under the RPC cap', () => {
    expect(blockRanges(0n, 9_999n, 5_000n)).toEqual([
      { fromBlock: 0n, toBlock: 4_999n },
      { fromBlock: 5_000n, toBlock: 9_999n },
    ]);
    expect(blockRanges(10n, 10n, 5_000n)).toEqual([{ fromBlock: 10n, toBlock: 10n }]);
    expect(blockRanges(10n, 9n)).toEqual([]);
    for (const r of blockRanges(1n, 123_456n)) expect(r.toBlock - r.fromBlock).toBeLessThan(10_000n);
  });

  it('concatenates chunk results and propagates failures', async () => {
    const seen: bigint[] = [];
    const logs = await getLogsChunked(0n, 12_000n, async (r) => (seen.push(r.fromBlock), [r.fromBlock]), 5_000n);
    expect(logs).toEqual([0n, 5_000n, 10_000n]);
    await expect(getLogsChunked(0n, 12_000n, async (r) => (r.fromBlock > 0n ? Promise.reject(new Error('rpc')) : []), 5_000n)).rejects.toThrow('rpc');
  });
});
