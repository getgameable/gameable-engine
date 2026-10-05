import { describe, expect, it } from 'vitest';

import { DeviceIdentity, deviceIdentity } from './DeviceIdentity.js';

const SECRET = 'a-test-secret-that-is-32-bytes-ok';
const NO_HEADERS = {};

/**
 * @param token A token.
 * @param at The index to change.
 * @returns The token with one character flipped.
 */
function flip(token: string, at: number): string {
  const c = token[at];
  const other = c === 'A' ? 'B' : 'A';
  return token.slice(0, at) + other + token.slice(at + 1);
}

describe('deviceIdentity', () => {
  it('mints a device.<random>.<hmac> token that verifies to a device id', async () => {
    const device = deviceIdentity(SECRET);
    const { token, identity } = await device.mint();
    expect(token).toMatch(/^device\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    const random = token.split('.')[1];
    expect(identity).toEqual({ id: `device:${random}`, name: '', kind: 'device' });
    expect(await device.resolve({ token, headers: NO_HEADERS })).toEqual(identity);
  });

  it('gives the same id for the same token every time (a reload)', async () => {
    const device = new DeviceIdentity(SECRET);
    const { token } = await device.mint();
    const first = await device.resolve({ token, headers: NO_HEADERS });
    const again = await deviceIdentity(SECRET).resolve({ token, headers: NO_HEADERS });
    expect(again).toEqual(first);
  });

  it('refuses a token with any one character flipped, in the random or the hmac', async () => {
    const device = deviceIdentity(SECRET);
    const { token } = await device.mint();
    for (let at = 'device.'.length; at < token.length; at += 1) {
      if (token[at] === '.') continue;
      expect(await device.resolve({ token: flip(token, at), headers: NO_HEADERS })).toBeNull();
    }
  });

  it("refuses another server's token and a forged one", async () => {
    const theirs = await deviceIdentity('another-secret-also-32-bytes-long').mint();
    const device = deviceIdentity(SECRET);
    expect(await device.resolve({ token: theirs.token, headers: NO_HEADERS })).toBeNull();
    const random = theirs.token.split('.')[1];
    const forged = `device.${random}.${'A'.repeat(43)}`;
    expect(await device.resolve({ token: forged, headers: NO_HEADERS })).toBeNull();
  });

  it('refuses malformed tokens and no token', async () => {
    const device = deviceIdentity(SECRET);
    const { token } = await device.mint();
    for (const bad of [
      '',
      'device',
      'device..',
      'x.y.z',
      `${token}.x`,
      `user${token.slice(6)}`,
      'device.!.!',
    ]) {
      expect(await device.resolve({ token: bad, headers: NO_HEADERS })).toBeNull();
    }
    expect(await device.resolve({ token: 'x'.repeat(5000), headers: NO_HEADERS })).toBeNull();
    expect(await device.resolve({ headers: NO_HEADERS })).toBeNull();
  });

  it('mints a different token each time', async () => {
    const device = deviceIdentity(SECRET);
    const a = await device.mint();
    const b = await device.mint();
    expect(a.token).not.toBe(b.token);
    expect(a.identity.id).not.toBe(b.identity.id);
  });

  it('refuses an empty secret', () => {
    expect(() => deviceIdentity('')).toThrow(/secret/);
  });
});
