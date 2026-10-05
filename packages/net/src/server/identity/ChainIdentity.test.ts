import { describe, expect, it, vi } from 'vitest';

import { chain } from './ChainIdentity.js';
import { deviceIdentity } from './DeviceIdentity.js';
import { IdentityProvider, type PlayerIdentity } from './IdentityProvider.js';
import { portalIdentity } from './PortalIdentity.js';

/** A provider that always answers the same. */
class Fixed extends IdentityProvider {
  constructor(private readonly answer: PlayerIdentity | null | Error) {
    super();
  }

  resolve(): Promise<PlayerIdentity | null> {
    if (this.answer instanceof Error) return Promise.reject(this.answer);
    return Promise.resolve(this.answer);
  }
}

const SECRET = 'a-test-secret-that-is-32-bytes-ok';

describe('chain', () => {
  it('falls through a portal 401 to the device token (the plan case)', async () => {
    const device = deviceIdentity(SECRET);
    const { token, identity } = await device.mint();
    const refused = vi.fn(() => Promise.resolve(new Response('{}', { status: 401 })));
    const portal = portalIdentity({ authUrl: 'https://auth.example', fetch: refused });
    const who = await chain([portal, device]).resolve({
      token,
      headers: { cookie: 'avataros_session=expired' },
    });
    expect(refused).toHaveBeenCalledOnce();
    expect(who).toEqual(identity);
  });

  it('takes the first provider that knows the player', async () => {
    const first = { id: 'u1', name: 'ana', kind: 'portal' } as const;
    const second = { id: 'device:x', name: '', kind: 'device' } as const;
    const who = await chain([new Fixed(null), new Fixed(first), new Fixed(second)]).resolve({
      headers: {},
    });
    expect(who).toEqual(first);
  });

  it('skips a provider that throws, and resolves null when nobody knows the player', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = { id: 'device:x', name: '', kind: 'device' } as const;
    expect(
      await chain([new Fixed(new Error('boom')), new Fixed(second)]).resolve({ headers: {} }),
    ).toEqual(second);
    expect(await chain([new Fixed(null)]).resolve({ headers: {} })).toBeNull();
    expect(await chain([]).resolve({ headers: {} })).toBeNull();
    error.mockRestore();
  });
});
