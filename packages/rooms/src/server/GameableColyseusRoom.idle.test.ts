/**
 * A connected client that sends no frame for `idleSeconds` (120 by default)
 * is dropped, and its seat is held as after any drop (phase 3 review I3): an
 * idle socket cannot keep a seat forever, and the player who comes back
 * inside the hold gets it again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IDLE_CLOSE_CODE } from '../channels.js';
import { stubEntry } from './testing/StubGame.js';
import { TestPlayer } from './testing/TestPlayer.js';
import { localRoom, startTestServer, type TestServer, waitFor } from './testing/testServer.js';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({ quiet: stubEntry({ idleSeconds: 0.4 }), plain: stubEntry() });
});

afterAll(async () => {
  await server.close();
});

describe('GameableColyseusRoom: an idle client', () => {
  it('drops a client that sends nothing, holds its seat, and gives it back on reconnect', async () => {
    const idle = await TestPlayer.create(server.endpoint, 'quiet', { name: 'I' });
    const busy = await TestPlayer.joinById(server.endpoint, idle.room.roomId, {
      name: 'B',
      game: 'quiet',
    });
    const timer = setInterval(() => {
      busy.sendInput();
    }, 50);
    const token = idle.room.reconnectionToken;
    const room = localRoom(idle.room.roomId);
    try {
      await waitFor(() => idle.leftWith !== null, 'the idle drop', 3000);
      expect(idle.leftWith).toBe(IDLE_CLOSE_CODE);
      expect(busy.leftWith).toBeNull(); // frames keep a client in
      const seat = room.seats.list().find((s) => s.player.id === 0);
      await waitFor(() => seat?.player.connected === false, 'the seat held');
      expect(room.players).toBe(2); // held, not freed
      await idle.reconnect(token);
      await waitFor(() => idle.replica.welcomes === 2, 'the seat back');
      expect(idle.replica.player).toBe(0);
    } finally {
      clearInterval(timer);
    }
    await Promise.all([idle.leave(), busy.leave()]);
  });

  it('waits 120 s by default', async () => {
    const player = await TestPlayer.create(server.endpoint, 'plain', { name: 'P' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(player.leftWith).toBeNull();
    await player.leave();
  });
});
