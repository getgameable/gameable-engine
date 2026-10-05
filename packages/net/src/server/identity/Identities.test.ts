import { describe, expect, it, vi } from 'vitest';

import { deviceIdentity } from './DeviceIdentity.js';
import { createIdentities } from './Identities.js';
import { portalIdentity } from './PortalIdentity.js';

const SECRET = 'a-test-secret-that-is-32-bytes-ok';

/**
 * @param status The status /auth/me answers.
 * @returns A portal provider over a fake fetch.
 */
function portalAnswering(status: number) {
  const fetch = vi.fn(() =>
    Promise.resolve(new Response(JSON.stringify({ id: 'u1', email: 'ana@b' }), { status })),
  );
  return portalIdentity({ authUrl: 'https://auth.example', fetch });
}

describe('Identities.identify', () => {
  it('mints a device token on first contact, and the token gives the same id after', async () => {
    const identities = createIdentities({ device: deviceIdentity(SECRET) });
    const first = await identities.identify({ headers: {} });
    expect(first.identity.kind).toBe('device');
    expect(first.minted).toMatch(/^device\./);
    const reload = await identities.identify({ token: first.minted ?? '', headers: {} });
    expect(reload.identity).toEqual(first.identity);
    expect(reload.minted).toBeNull();
  });

  it('a forged token gets a fresh device id, never the one it names', async () => {
    const identities = createIdentities({ device: deviceIdentity(SECRET) });
    const real = await identities.identify({ headers: {} });
    const token = real.minted ?? '';
    const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const after = await identities.identify({ token: forged, headers: {} });
    expect(after.minted).not.toBeNull();
    expect(after.identity.id).not.toBe(real.identity.id);
  });

  it('a signed-in player is the portal user; a device token is still minted for later', async () => {
    const identities = createIdentities({
      device: deviceIdentity(SECRET),
      portal: portalAnswering(200),
    });
    const who = await identities.identify({ headers: { cookie: 'avataros_session=jwt' } });
    expect(who.identity).toEqual({ id: 'u1', name: 'ana', kind: 'portal' });
    expect(who.minted).toMatch(/^device\./);
    const again = await identities.identify({
      token: who.minted ?? '',
      headers: { cookie: 'avataros_session=jwt' },
    });
    expect(again.identity.id).toBe('u1');
    expect(again.minted).toBeNull();
  });

  it('a portal 401 falls through to the device token', async () => {
    const device = deviceIdentity(SECRET);
    const { token, identity } = await device.mint();
    const identities = createIdentities({ device, portal: portalAnswering(401) });
    const who = await identities.identify({ token, headers: { cookie: 'avataros_session=old' } });
    expect(who.identity).toEqual(identity);
    expect(who.minted).toBeNull();
  });
});
