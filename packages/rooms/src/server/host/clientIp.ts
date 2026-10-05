/**
 * Which client a matchmaking request or upgrade came from, as a limit key.
 */
import { isIPv4, isIPv6 } from 'node:net';

/**
 * The header the server writes on every HTTP request and upgrade, before
 * Colyseus reads it, with the socket's peer address. Any value a client sent is
 * overwritten.
 *
 * @example
 * ```ts
 * import { PEER_HEADER } from 'gameable/rooms/server';
 *
 * console.log(PEER_HEADER); // 'x-aos-peer'
 * ```
 */
export const PEER_HEADER = 'x-aos-peer';

/**
 * The limit key for an address. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
 * is its IPv4 address; any other IPv6 address is its /64 (`2001:db8:1:2::/64`),
 * because one host is handed a whole /64 and would otherwise get 2^64 budgets.
 * Anything that is not an address is kept as it is.
 *
 * @param address An address.
 * @returns The key.
 *
 * @example
 * ```ts
 * import { addressKey } from 'gameable/rooms/server';
 *
 * addressKey('::ffff:203.0.113.7'); // '203.0.113.7'
 * addressKey('2001:db8:1:2:aaaa::1'); // '2001:db8:1:2::/64'
 * ```
 */
export function addressKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped !== null) return mapped[1];
  if (isIPv4(address) || !isIPv6(address)) return address;
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const groups = address.includes('::')
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * The client's limit key. By default (`hops` 0) it is the socket's peer:
 * headers a client can write (`X-Forwarded-For`, `X-Real-IP`) are ignored. Behind
 * proxies, `hops` is how many of them there are (nginx alone: 1; Traefik then
 * nginx: 2): the client is the entry `hops` places from the right of
 * `X-Forwarded-For`, since each trusted proxy appended the address it saw, and
 * the entries further left are the client's to write. With fewer entries than
 * that, the leftmost is used. Colyseus's own `AuthContext.ip` takes the first
 * entry, which a client chooses, so it is not used.
 *
 * @param headers The request's headers.
 * @param hops Trusted proxies in front of the server; 0 for none.
 * @returns The key (see `addressKey`), or `unknown`.
 *
 * @example
 * ```ts
 * import { clientIpOf } from 'gameable/rooms/server';
 *
 * const headers = new Headers({ 'x-aos-peer': '10.0.0.3', 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' });
 * clientIpOf(headers, 0); // '10.0.0.3'
 * clientIpOf(headers, 2); // '203.0.113.7'
 * ```
 */
export function clientIpOf(headers: Headers, hops: number): string {
  if (hops > 0) {
    const chain = headers.get('x-forwarded-for')?.split(',').map((hop) => hop.trim()) ?? [];
    const client = chain.length > 0 ? chain[Math.max(0, chain.length - hops)] : '';
    if (client !== '') return addressKey(client);
  }
  const peer = headers.get(PEER_HEADER);
  return peer === null || peer === '' ? 'unknown' : addressKey(peer);
}
