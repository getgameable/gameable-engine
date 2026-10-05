/**
 * Task 5.3: `createRoomServer` builds its identities from the environment by
 * default, so a production server with a short `ROOMS_SECRET` never starts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRoomServer } from './createRoomServer.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createRoomServer: identities from the environment', () => {
  it('refuses to start in production with a ROOMS_SECRET under 32 bytes', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ROOMS_SECRET', 'short');
    expect(() => createRoomServer({ port: 0, origins: [], games: {} })).toThrow(/32 bytes/);
  });

  it('refuses a malformed GAMEABLE_AUTH_URL', () => {
    vi.stubEnv('ROOMS_SECRET', 'x'.repeat(32));
    vi.stubEnv('GAMEABLE_AUTH_URL', 'auth.example.com');
    expect(() => createRoomServer({ port: 0, origins: [], games: {} })).toThrow(
      /GAMEABLE_AUTH_URL/,
    );
  });
});
