/**
 * The room server container's smoke test, run against a server that is
 * already up (the image `deploy/rooms/Dockerfile` builds, or `gameable
 * serve`); skipped unless `GAMEABLE_ROOMS_URL` names one:
 *
 *     GAMEABLE_ROOMS_URL=http://127.0.0.1:8790 npx vitest run packages/rooms/src/server/host/container.smoke.test.ts
 *
 * `/health` answers, and two `@colyseus/sdk` players join the same game by
 * code and each sees the other's spawn. `GAMEABLE_ROOMS_GAME` names the game
 * (default `example-mystery`, the image's baked game) and `GAMEABLE_ROOMS_ORIGIN`
 * the page origin sent (default `http://localhost:5192`).
 */
import { describe, expect, it } from 'vitest';

import { TestPlayer } from '../testing/TestPlayer.js';

const URL_ = process.env.GAMEABLE_ROOMS_URL ?? '';
const GAME = process.env.GAMEABLE_ROOMS_GAME ?? 'example-mystery';
const HEADERS = { origin: process.env.GAMEABLE_ROOMS_ORIGIN ?? 'http://localhost:5192' };

/**
 * @param check Polled until true.
 * @param what What is awaited, for the timeout message.
 */
async function until(check: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(URL_ === '')('room server container smoke', () => {
  it('answers /health', async () => {
    const response = await fetch(new URL('/health', URL_));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  it("two players join one room by code and see each other's spawn", async () => {
    const endpoint = URL_.replace(/^http/, 'ws');
    const a = await TestPlayer.create(endpoint, GAME, { name: 'A' }, HEADERS);
    const b = await TestPlayer.joinById(endpoint, a.room.roomId, { name: 'B', game: a.room.name }, HEADERS);
    try {
      expect(a.room.roomId).toMatch(/^[A-Z]{4}$/);
      await until(() => a.replica.welcomes > 0 && b.replica.welcomes > 0, 'both welcomes');
      await until(
        () => a.replica.entities.has(b.replica.entity) && b.replica.entities.has(a.replica.entity),
        "each other's spawn",
      );
      expect(a.replica.entity).not.toBe(b.replica.entity);
      console.log(
        `smoke: room ${a.room.roomId}, A=${String(a.replica.entity)} at ${String([...a.replica.seen(a.replica.entity)])}, ` +
          `B=${String(b.replica.entity)} at ${String([...b.replica.seen(b.replica.entity)])}`,
      );
    } finally {
      await b.leave();
      await a.leave();
    }
  }, 30_000);
});
