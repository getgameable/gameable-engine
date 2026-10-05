/**
 * The IPv6-loopback guard of the rooms tests (phase 3 review M2): the probe
 * answers false on a bind that fails, rather than throwing.
 */
import { describe, expect, it } from 'vitest';

import { canListenOn } from './ipv6.js';

describe('canListenOn', () => {
  it('answers true for the IPv4 loopback and false for an address this machine does not have', async () => {
    expect(await canListenOn('127.0.0.1')).toBe(true);
    expect(await canListenOn('192.0.2.1')).toBe(false); // TEST-NET-1: never a local address
  });
});
