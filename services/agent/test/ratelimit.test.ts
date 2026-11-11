import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter, clientKey } from '../src/ratelimit';

describe('fixed-window rate limiter', () => {
  it('allows perMin requests per key in a window, then answers with the wait until it resets', () => {
    const limiter = new FixedWindowLimiter(2);
    expect(limiter.take('a', 1_000)).toBe(0);
    expect(limiter.take('a', 2_000)).toBe(0);
    // The window opened at 1 000 ms, so it closes at 61 000 ms.
    expect(limiter.take('a', 31_000)).toBe(30_000);
  });

  it('counts each key on its own', () => {
    const limiter = new FixedWindowLimiter(1);
    expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.take('b', 0)).toBe(0);
    expect(limiter.take('a', 0)).toBeGreaterThan(0);
  });

  it('opens a new window once the old one has passed', () => {
    const limiter = new FixedWindowLimiter(1);
    expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.take('a', 59_999)).toBe(1);
    expect(limiter.take('a', 60_000)).toBe(0);
  });

  it('never limits when perMin is 0 (off)', () => {
    const limiter = new FixedWindowLimiter(0);
    for (let i = 0; i < 1_000; i++) expect(limiter.take('a', 0)).toBe(0);
    expect(limiter.size).toBe(0);
  });

  it('drops expired windows once it tracks maxKeys, so memory stays bounded', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, 3);
    for (const k of ['a', 'b', 'c']) limiter.take(k, 0);
    limiter.take('d', 60_000);
    expect(limiter.size).toBe(1);
  });

  it('evicts the oldest window when every tracked key is still active', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, 2);
    limiter.take('a', 0);
    limiter.take('b', 0);
    limiter.take('c', 1);
    expect(limiter.size).toBe(2);
  });
});

describe('client key', () => {
  it('uses the visitor address Cloudflare reports when a proxy on this host or network forwarded the request', () => {
    expect(clientKey('127.0.0.1', '203.0.113.7')).toBe('203.0.113.7'); // cloudflared on this machine
    expect(clientKey('::1', ['203.0.113.8', '203.0.113.9'])).toBe('203.0.113.8');
    expect(clientKey('10.0.0.5', '203.0.113.7')).toBe('203.0.113.7'); // a tunnel container on a private network
    expect(clientKey('127.0.0.1', '::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('counts IPv6 visitors per /64, the block one host or customer gets, so rotating addresses does not escape it', () => {
    expect(clientKey('::ffff:127.0.0.1', '2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('127.0.0.1', '2001:0DB8:0:0:aaaa::1')).toBe('2001:db8:0:0::/64');
    expect(clientKey('2001:db8:1:2:3:4:5:6', undefined)).toBe('2001:db8:1:2::/64');
  });

  it('exempts local tooling and proxies that do not say who the visitor is', () => {
    expect(clientKey('127.0.0.1', undefined)).toBeNull();
    expect(clientKey('::1', '')).toBeNull();
    expect(clientKey('172.17.0.1', undefined)).toBeNull(); // e.g. a platform load balancer: limit there instead
  });

  it('ignores the header from a public peer, which could forge it', () => {
    expect(clientKey('198.51.100.9', '203.0.113.7')).toBe('198.51.100.9');
    expect(clientKey(undefined, '203.0.113.7')).toBe('unknown');
  });
});
