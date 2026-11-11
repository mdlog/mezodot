import { isIPv4, isIPv6 } from 'node:net';

/**
 * Fixed-window request counter per key: at most `perMin` requests in each `windowMs` window, which opens with the
 * key's first request. `perMin` 0 turns it off. Memory stays bounded at `maxKeys`: expired windows are dropped first,
 * then the oldest live one.
 */
export class FixedWindowLimiter {
  // Insertion order is window-start order (a renewed window is re-inserted), so expired windows sit at the front.
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly perMin: number,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts a request for `key`: 0 when allowed, otherwise the milliseconds until the key's window resets. */
  take(key: string, now = Date.now()): number {
    if (this.perMin <= 0) return 0;
    const window = this.windows.get(key);
    if (window && now - window.start < this.windowMs) {
      if (window.count >= this.perMin) return window.start + this.windowMs - now;
      window.count++;
      return 0;
    }
    this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) this.evict(now);
    this.windows.set(key, { start: now, count: 1 });
    return 0;
  }

  get size(): number {
    return this.windows.size;
  }

  private evict(now: number) {
    for (const [key, window] of this.windows) {
      if (now - window.start < this.windowMs) break;
      this.windows.delete(key);
    }
    if (this.windows.size >= this.maxKeys) this.windows.delete(this.windows.keys().next().value!);
  }
}

const unmapped = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

/** Loopback, RFC 1918, link-local or unique-local: where a proxy on this host or its network connects from. */
function isLocalPeer(address: string): boolean {
  const ip = unmapped(address.toLowerCase());
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/** An IPv4 address as is; an IPv6 address as its /64 ("2001:db8:0:0::/64"). */
function addressKey(address: string): string {
  const ip = unmapped(address.trim().toLowerCase()).split('%')[0]!;
  if (!isIPv6(ip)) return isIPv4(ip) ? ip : ip.slice(0, 64);
  const [head = '', tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/**
 * Whom a request counts against. A proxy on this host or network (cloudflared, a tunnel container) forwards every
 * visitor from its own address, so the visitor is the CF-Connecting-IP header, which Cloudflare sets and overwrites.
 * It is read from such a peer only: a public peer could forge it. A local peer without it is local tooling or a
 * proxy that does not say who the visitor is: null, not limited here.
 */
export function clientKey(peer: string | undefined, cfConnectingIp: string | string[] | undefined): string | null {
  if (!peer) return 'unknown';
  if (!isLocalPeer(peer)) return addressKey(peer);
  const visitor = (Array.isArray(cfConnectingIp) ? cfConnectingIp[0] : cfConnectingIp)?.trim();
  return visitor ? addressKey(visitor) : null;
}
