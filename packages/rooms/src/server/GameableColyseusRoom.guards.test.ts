/**
 * The room's guards, against a real Colyseus server on port 0 and the real
 * tiny game (one room at a time): frames the parser refuses, the budget, and
 * a held seat that expires.
 */
import { CloseCode } from '@colyseus/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TestPlayer } from './testing/TestPlayer.js';
import {
  killSocket,
  localRoom,
  noRoomsLeft,
  startTestServer,
  type TestServer,
  tinyEntry,
  waitFor,
} from './testing/testServer.js';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    tiny: tinyEntry(),
    brief: tinyEntry({ reconnectSeconds: 0.5 }),
  });
});

// One direct-mode tiny room at a time: each test's room is gone before the next starts.
afterEach(async () => {
  await noRoomsLeft();
});

afterAll(async () => {
  await server.close();
});

describe('GameableColyseusRoom guards', () => {
  it('refuses a frame of an unknown client type, and a hello, through the parser', async () => {
    const a = await TestPlayer.joinOrCreate(server.endpoint, 'tiny', { name: 'A' });
    await waitFor(() => a.replica.welcomes === 1, 'the welcome');
    const intake = localRoom(a.room.roomId).intake;
    a.sendText('{"t":"teleport","to":[0,100,0]}');
    a.sendText('{"t":"hello","v":1,"room":"x","name":"again"}');
    a.sendText('not json');
    a.sendText('{"t":"msg","name":"ping","payload":{}}'); // the tiny game answers "pong"
    await waitFor(() => a.replica.messages.some((m) => m.name === 'pong'), "the game's pong");
    expect(intake.counts).toMatchObject({ bad: 3, text: 1 });
    expect(a.leftWith).toBeNull(); // a refused frame is ignored, not punished
    await a.leave();
  });

  it('tells a client out of text budget once, then drops it on sustained abuse and frees the seat', async () => {
    const a = await TestPlayer.joinOrCreate(server.endpoint, 'tiny', { name: 'A' });
    const b = await TestPlayer.joinById(server.endpoint, a.room.roomId, {
      name: 'B',
      game: a.room.name,
    });
    await waitFor(
      () => a.replica.entity !== 0 && b.replica.entities.has(a.replica.entity),
      'A spawned',
    );
    const entityA = a.replica.entity;
    for (let i = 0; i < 45; i += 1) a.sendText(`{"t":"ping","at":${String(i)}}`); // burst is 40
    await waitFor(() => a.replica.errors.length > 0, 'A told');
    await waitFor(() => a.replica.counts.pong === 40, 'the 40 pongs');
    expect(a.leftWith).toBeNull(); // out of budget is not abuse yet: told, still seated
    for (let i = 0; i < 95; i += 1) a.sendText(`{"t":"ping","at":${String(i)}}`); // 100 refused in a row
    await waitFor(() => a.leftWith !== null, 'A dropped');
    expect(a.replica.errors).toEqual([{ code: 'budget', detail: undefined }]); // told once
    expect(a.leftWith).toBe(CloseCode.WITH_ERROR);
    expect(a.replica.counts.pong).toBe(40);
    // No hold for a dropped abuser: the seat goes at once and its entity despawns.
    await waitFor(() => b.replica.despawned.includes(entityA), 'B sees A despawn');
    expect(b.replica.players.map((p) => p.id)).toEqual([1]);
    await b.leave();
  });

  it('expires a held seat: the game lets the player go and the entity despawns', async () => {
    const a = await TestPlayer.joinOrCreate(server.endpoint, 'brief', { name: 'A' });
    const b = await TestPlayer.joinById(server.endpoint, a.room.roomId, {
      name: 'B',
      game: a.room.name,
    });
    await waitFor(
      () => a.replica.entity !== 0 && b.replica.entities.has(a.replica.entity),
      'A spawned',
    );
    const entityA = a.replica.entity;
    const roomId = a.room.roomId;
    const token = a.room.reconnectionToken;
    killSocket(roomId, a.room.sessionId);
    await waitFor(
      () => b.replica.players.find((p) => p.id === 0)?.connected === false,
      'B sees A held',
    );
    expect(b.replica.entities.has(entityA)).toBe(true); // held: the entity stays
    await waitFor(() => b.replica.despawned.includes(entityA), 'the hold expires', 3000);
    expect(b.replica.players.map((p) => p.id)).toEqual([1]);
    await expect(a.reconnect(token)).rejects.toThrow();
    // The freed seat 0 is the lowest free one, so the next joiner takes it.
    const c = await TestPlayer.joinById(server.endpoint, roomId, { name: 'C', game: b.room.name });
    await waitFor(() => c.replica.welcomes === 1, "C's welcome");
    expect(c.replica.player).toBe(0);
    await Promise.all([b.leave(), c.leave()]);
  });
});
