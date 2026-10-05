/**
 * Two `@colyseus/sdk` players against a real Colyseus server on port 0
 * running the real tiny game through `createEngineRoomGame`. Everything on
 * the wire after Colyseus's one-byte header is ours: INPUT out; welcome,
 * `cmd` and rows in, decoded by our codecs.
 */
import type { EngineRoomGame } from '@gameable/net/server';
import { Protocol } from '@colyseus/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROOM_STATE, ROOM_STATE_PATCH } from '../channels.js';
import { TestPlayer } from './testing/TestPlayer.js';
import {
  groundDistance,
  holdFor,
  killSocket,
  localRoom,
  startTestServer,
  type TestServer,
  tinyEntry,
  waitFor,
} from './testing/testServer.js';

const STEP_MM = 0.001; // the quantizer's step: whole millimetres
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ tiny: tinyEntry() });
});

afterAll(async () => {
  await server.close();
});

/**
 * @param roomId A room in this process.
 * @param entity An entity.
 * @returns The authority's own position of that entity, now.
 */
function authority(roomId: string, entity: number): Float32Array {
  const game = localRoom(roomId).game as EngineRoomGame;
  const record = game.adapter.world.get(entity);
  if (record === undefined) throw new Error(`no entity ${String(entity)} on the authority`);
  return Float32Array.from(record.position);
}

describe('GameableColyseusRoom over the tiny game', () => {
  it('rides the Colyseus protocol codes it claims', () => {
    expect([ROOM_STATE, ROOM_STATE_PATCH]).toEqual([
      Protocol.ROOM_STATE,
      Protocol.ROOM_STATE_PATCH,
    ]);
  });

  it('two players agree on a walked entity, survive a killed socket, and a third is refused', async () => {
    const a = await TestPlayer.joinOrCreate(server.endpoint, 'tiny', { name: 'A' });
    const b = await TestPlayer.joinOrCreate(server.endpoint, 'tiny', { name: 'B' });
    const roomId = a.room.roomId;
    expect(b.room.roomId).toBe(roomId);
    await waitFor(() => a.replica.welcomes === 1 && b.replica.welcomes === 1, 'both welcomes');
    expect([a.replica.player, b.replica.player]).toEqual([0, 1]); // seats from 0

    // "Your entity" arrives in A's own cmd frames, and both replicate it.
    await waitFor(() => a.replica.entity !== 0, 'A is told its entity');
    const entityA = a.replica.entity;
    expect(entityA).toBe((localRoom(roomId).game as EngineRoomGame).entityOf(0));
    expect(a.replica.names.get(entityA)).toBe('player');
    await waitFor(() => b.replica.entities.has(entityA), 'B replicates A');
    expect(b.replica.entity).not.toBe(entityA);

    const settled = (): boolean => {
      const p = authority(roomId, entityA);
      return (
        groundDistance(a.replica.seen(entityA), p) <= STEP_MM &&
        groundDistance(b.replica.seen(entityA), p) <= STEP_MM
      );
    };
    await waitFor(settled, 'A at rest on both replicas');
    const start = Float32Array.from(a.replica.seen(entityA));
    await holdFor(a, ['KeyW'], 1000);
    await waitFor(settled, 'both replicas at the authority position');
    const moved = groundDistance(start, a.replica.seen(entityA));
    expect(moved).toBeGreaterThan(3); // WALK_SPEED is 4 m/s
    expect(moved).toBeLessThan(4.6);
    await waitFor(() => a.replica.ack === a.sentSeq, 'the cmd ack reaches our last input seq');

    // Kill A's socket: an abnormal close (1006), not a leave. The seat is held.
    const token = a.room.reconnectionToken;
    const sessionId = a.room.sessionId;
    killSocket(roomId, sessionId);
    await waitFor(() => a.leftWith !== null, 'A sees its socket close');
    await waitFor(
      () => b.replica.players.find((p) => p.id === 0)?.connected === false,
      'B sees A held',
    );
    // The held seat counts toward full.
    await expect(
      TestPlayer.joinById(server.endpoint, roomId, { name: 'C', game: b.room.name }),
    ).rejects.toThrow();

    // Back with the reconnection token: same seat, same entity, a fresh welcome.
    await a.reconnect(token);
    await waitFor(() => a.replica.welcomes === 2, 'a fresh welcome on reconnect');
    expect(a.room.sessionId).toBe(sessionId);
    expect(a.replica.player).toBe(0);
    expect(a.replica.welcomeEntity).toBe(entityA); // the welcome itself says which entity is ours
    expect(a.replica.entities.has(entityA)).toBe(true);
    await waitFor(
      () => b.replica.players.find((p) => p.id === 0)?.connected === true,
      'B sees A back',
    );
    await waitFor(settled, 'A at rest after the reconnect');
    const before = Float32Array.from(a.replica.seen(entityA));
    await holdFor(a, ['KeyW'], 500);
    await waitFor(settled, 'both replicas at the authority position after the reconnect');
    expect(groundDistance(before, a.replica.seen(entityA))).toBeGreaterThan(1);

    // Full: a third player is refused by id. (That joinOrCreate then makes a new room is
    // the stub test's: two direct-mode tiny rooms must never be live in one process.)
    await expect(
      TestPlayer.joinById(server.endpoint, roomId, { name: 'C', game: b.room.name }),
    ).rejects.toThrow();
    await Promise.all([a.leave(), b.leave()]);
  });
});
