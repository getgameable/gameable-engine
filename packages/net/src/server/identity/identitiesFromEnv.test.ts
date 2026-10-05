import { afterEach, describe, expect, it, vi } from 'vitest';

import { identitiesFromEnv } from './identitiesFromEnv.js';

const LONG = 'x'.repeat(32);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('identitiesFromEnv', () => {
  it('refuses to start in production without ROOMS_SECRET, or with one under 32 bytes', () => {
    expect(() => identitiesFromEnv({ NODE_ENV: 'production' })).toThrow(/ROOMS_SECRET/);
    expect(() =>
      identitiesFromEnv({ NODE_ENV: 'production', ROOMS_SECRET: 'x'.repeat(31) }),
    ).toThrow(/32 bytes/);
    expect(() => identitiesFromEnv({ NODE_ENV: 'production', ROOMS_SECRET: LONG })).not.toThrow();
  });

  it('counts bytes, not characters', () => {
    // 16 two-byte characters: 32 bytes.
    expect(() =>
      identitiesFromEnv({ NODE_ENV: 'production', ROOMS_SECRET: 'é'.repeat(16) }),
    ).not.toThrow();
  });

  it('outside production, a missing secret is a random one for this process, with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const identities = identitiesFromEnv({});
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ROOMS_SECRET/));
    const who = await identities.identify({ headers: {} });
    expect(who.identity.kind).toBe('device');
  });

  it('adds the portal when GAMEABLE_AUTH_URL is set, and refuses a malformed one', () => {
    const identities = identitiesFromEnv({
      ROOMS_SECRET: LONG,
      GAMEABLE_AUTH_URL: 'https://auth.example',
    });
    expect(identities.portal).not.toBeNull();
    expect(identitiesFromEnv({ ROOMS_SECRET: LONG }).portal).toBeNull();
    expect(() =>
      identitiesFromEnv({ ROOMS_SECRET: LONG, GAMEABLE_AUTH_URL: 'auth.example' }),
    ).toThrow(/GAMEABLE_AUTH_URL/);
  });
});
