/**
 * `gameable serve` builds its player store from `GAMEABLE_PG_URL` before it opens
 * a game: a database it cannot reach or migrate stops the start, with a
 * message that never carries the password.
 */
import { describe, expect, it } from 'vitest';

import { resolveServeOptions } from './options.js';
import { startServe } from './startServe.js';

describe('gameable serve: the player store', () => {
  it('refuses to start on an GAMEABLE_PG_URL it cannot migrate, and keeps the password out', async () => {
    const options = resolveServeOptions(['--games', '/no/such/games', '--port', '0'], '/g', {});
    const env = { GAMEABLE_PG_URL: 'postgres://aos:hunter2-secret@127.0.0.1:1/rooms' };
    const error = await startServe(options, undefined, env).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toMatch(/player store migrations failed/);
    expect(error?.message).not.toContain('hunter2-secret');
  }, 30_000);
});
