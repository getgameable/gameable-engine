import { describe, expect, it } from 'vitest';

import { addressKey, clientIpOf, PEER_HEADER } from './clientIp.js';
import { OVERFLOW_KEY, TokenBuckets } from './TokenBuckets.js';

describe('TokenBuckets', () => {
  it('spends a burst, refuses past it, and refills one token per refillMs', () => {
    let now = 0;
    const buckets = new TokenBuckets({ burst: 3, refillMs: 2000 }, () => now);
    expect([1, 2, 3].map(() => buckets.take('a'))).toEqual([true, true, true]);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.has('a')).toBe(false);
    expect(buckets.take('b')).toBe(true); // per key
    now += 1999;
    expect(buckets.take('a')).toBe(false);
    now += 1;
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    now += 60_000;
    expect([1, 2, 3, 4].map(() => buckets.take('a'))).toEqual([true, true, true, false]); // capped at burst
  });

  it('refuses a bucket that can never hold a token', () => {
    expect(() => new TokenBuckets({ burst: 0, refillMs: 1 })).toThrow(/burst/);
  });

  it('stays cheap per request with 20,000 distinct addresses: no scan per new key', () => {
    const buckets = new TokenBuckets({ burst: 10, refillMs: 2000 });
    const started = performance.now();
    for (let i = 0; i < 20_000; i += 1) buckets.take(`198.${String(i >> 16)}.${String((i >> 8) & 255)}.${String(i & 255)}`);
    const ms = performance.now() - started;
    expect(buckets.size).toBe(20_000);
    expect(ms).toBeLessThan(1000); // round 2's per-insert sweep took ~3.5 s here; this is loose for CI
  });

  it('sweeps refilled buckets at most once every few seconds, and only those', () => {
    let now = 0;
    const buckets = new TokenBuckets({ burst: 2, refillMs: 1000 }, () => now);
    buckets.take('idle');
    buckets.take('busy');
    now = 2500; // both refilled, but the sweep waits for its 5 s
    buckets.take('busy');
    expect(buckets.size).toBe(2);
    now = 5000;
    buckets.take('busy'); // the sweep runs first: every full bucket goes, then busy spends again
    buckets.take('busy');
    expect(buckets.size).toBe(1); // 'idle' is gone
    expect(buckets.has('busy')).toBe(false); // and busy's spending survived the sweep
  });

  it('holds at most maxKeys keys: past it every new key spends from one shared bucket', () => {
    const buckets = new TokenBuckets({ burst: 2, refillMs: 60_000 }, () => 0, 3);
    for (const key of ['a', 'b', 'c']) buckets.take(key);
    expect(buckets.take('d')).toBe(true); // the overflow bucket's first token
    expect(buckets.take('e')).toBe(true); // ...its second, shared with d
    expect(buckets.take('f')).toBe(false); // a flood of new keys buys one budget between them
    expect(buckets.take('a')).toBe(true); // a held key keeps its own
    expect(buckets.size).toBe(4); // a, b, c and OVERFLOW_KEY
    expect(OVERFLOW_KEY).toMatch(/overflow/);
  });
});

describe('clientIpOf and addressKey', () => {
  const headers = new Headers({
    [PEER_HEADER]: '10.0.0.3',
    'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2',
    'x-real-ip': '9.9.9.9',
  });

  it('is the socket peer with trustProxy 0: headers a client writes count for nothing', () => {
    expect(clientIpOf(headers, 0)).toBe('10.0.0.3');
    expect(clientIpOf(new Headers(), 0)).toBe('unknown');
  });

  it('with one hop (nginx), is the last X-Forwarded-For entry', () => {
    expect(clientIpOf(headers, 1)).toBe('10.0.0.2');
  });

  it('with two hops (Traefik, then nginx), is the second from the right: the client, not the first proxy', () => {
    expect(clientIpOf(headers, 2)).toBe('203.0.113.7');
    expect(clientIpOf(new Headers({ 'x-forwarded-for': '203.0.113.7' }), 2)).toBe('203.0.113.7'); // shorter chain: leftmost
    expect(clientIpOf(new Headers({ [PEER_HEADER]: '10.0.0.3' }), 2)).toBe('10.0.0.3');
  });

  it('folds an IPv4-mapped address to IPv4, and puts one IPv6 /64 in one bucket', () => {
    expect(addressKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientIpOf(new Headers({ [PEER_HEADER]: '::ffff:203.0.113.7' }), 0)).toBe('203.0.113.7');
    const a = addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    const b = addressKey('2001:0db8:0001:0002::1');
    expect(a).toBe('2001:db8:1:2::/64');
    expect(b).toBe(a);
    expect(addressKey('2001:db8:1:3::1')).not.toBe(a);
    const buckets = new TokenBuckets({ burst: 1, refillMs: 60_000 });
    expect(buckets.take(a)).toBe(true);
    expect(buckets.take(b)).toBe(false); // the same /64: one budget
  });
});
