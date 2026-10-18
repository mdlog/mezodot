import { describe, expect, it } from 'vitest';
import { GAS_FLOOR, gasWithBuffer } from '../src';

describe('gasWithBuffer', () => {
  it('adds 30% plus 20k gas to a node estimate (no floor: unchanged behaviour)', () => {
    expect(gasWithBuffer(77_882n)).toBe(121_246n);
    expect(gasWithBuffer(0n)).toBe(20_000n);
  });

  it('never goes below the floor for the call type', () => {
    // Mezo testnet: a Pyth push estimated at ~31k (as if no code ran) ran out at its 60,534 limit; ~130k is needed.
    expect(gasWithBuffer(31_000n, GAS_FLOOR.pythUpdate)).toBe(200_000n);
    expect(gasWithBuffer(24_000n, GAS_FLOOR.vaaRelay)).toBe(250_000n);
    expect(gasWithBuffer(800_000n, GAS_FLOOR.supraProof)).toBe(1_200_000n);
  });

  it('keeps the buffered estimate when it is above the floor', () => {
    expect(gasWithBuffer(1_000_000n, GAS_FLOOR.supraProof)).toBe(1_320_000n);
    expect(gasWithBuffer(170_000n, GAS_FLOOR.pythUpdate)).toBe(241_000n);
  });

  it('floors cover the usage measured on Mezo testnet', () => {
    expect(GAS_FLOOR.pythUpdate).toBeGreaterThan(130_032n);
    expect(GAS_FLOOR.vaaRelay).toBeGreaterThan(163_000n);
    expect(GAS_FLOOR.supraProof).toBeGreaterThan(1_000_000n);
  });
});
