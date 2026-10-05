/**
 * `/health` and the process-wide backstop. Once a room fails to build because
 * this process's physics is broken (Jolt aborted, or would not start), `ok`
 * goes false and stays false, so the orchestrator replaces the process (M7).
 * Failed lookups across every address share a backstop budget (I2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getHealth, post } from '../testing/httpProbe.js';
import { hasIpv6Loopback } from '../testing/ipv6.js';
import { stubGame } from '../testing/StubGame.js';
import { TestPlayer } from '../testing/TestPlayer.js';
import { createRoomCodes } from './codes.js';
import { createRoomServer, type RoomServer } from './createRoomServer.js';
import { createRoomRegistry } from './RoomRegistry.js';

const ORIGIN = 'http://game.test';
const HEADERS = { origin: ORIGIN };
/** `::1` is the second client address below; a host without an IPv6 loopback skips that case (M2). */
const ipv6 = await hasIpv6Loopback('createRoomServer.health.test');
let server: RoomServer;
let port: number;
let endpoint: string;

beforeAll(async () => {
  server = createRoomServer({
    port: 0,
    host: ipv6 ? '::' : '127.0.0.1',
    origins: [ORIGIN],
    games: {
      stub: stubGame(),
      flaky: stubGame({ create: () => Promise.reject(new Error('build failed: a bad level file')) }),
      broken: stubGame({ create: () => Promise.reject(new Error('module "physics" failed to init')) }),
    },
    limits: { globalMisses: { burst: 3, refillMs: 60_000 } },
  });
  port = await server.listen();
  endpoint = `ws://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await server.close();
});

describe('createRoomServer: health and the backstop', () => {
  it.skipIf(!ipv6)('spends one process-wide budget of failed lookups across addresses', async () => {
    const guess = (host: string): Promise<number> =>
      post(port, '/matchmake/joinById/QQQQ', { origin: ORIGIN, host }).then((r) => r.status);
    const statuses = [await guess('127.0.0.1'), await guess('::1'), await guess('127.0.0.1')];
    expect(statuses.every((s) => s !== 429)).toBe(true);
    expect(await guess('::1')).toBe(429); // ::1 has 8 of its own left; the process has none
  });

  it('stays ok when a build fails for the game, not the process', async () => {
    await expect(TestPlayer.create(endpoint, 'flaky', {}, HEADERS)).rejects.toThrow(/bad level/);
    expect(server.health().ok).toBe(true);
    expect((await getHealth(port)).status).toBe(200);
  });

  it('goes not ok, and stays so, once a room could not start its physics', async () => {
    await expect(TestPlayer.create(endpoint, 'broken', {}, HEADERS)).rejects.toThrow(/physics/);
    expect(server.health().ok).toBe(false);
    const health = await getHealth(port);
    expect(health.body).toMatchObject({ ok: false });
    expect(health.status).toBe(503); // the HEALTHCHECK and the reverse proxy read the status (I2)
    const good = await TestPlayer.create(endpoint, 'stub', {}, HEADERS); // rooms may still run
    expect(server.health().ok).toBe(false);
    await good.leave();
  });

  it('marks a registry broken on a Jolt abort (what the process guard reports), and only on one', () => {
    const registry = createRoomRegistry(1, createRoomCodes());
    registry.noteFailure(new Error('TypeError: x is undefined'));
    expect(registry.broken).toBeNull();
    registry.noteFailure(new Error('Aborted(OOM)'));
    expect(registry.broken).toBe('Aborted(OOM)');
  });
});
