/**
 * What `GameableColyseusRoom.onAuth` checks before a seat is taken (phase 3
 * review): the protocol version (contract M1), that the join names this
 * room's game (I5), and the game's own `admit` hook (I6). A bare Colyseus
 * server on port 0, `@colyseus/sdk` players.
 */
import { PROTOCOL_VERSION } from '@gameable/net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { StubGame, stubEntry } from './testing/StubGame.js';
import { TestPlayer } from './testing/TestPlayer.js';
import { localRoom, startTestServer, type TestServer, waitFor } from './testing/testServer.js';

/** A game that seats only players named `moon`. */
class FullMoonGame extends StubGame {
  readonly asked: { name: string; token: string | undefined }[] = [];

  admit(name: string, token: string | undefined): Promise<string | null> {
    this.asked.push({ name, token });
    return Promise.resolve(name === 'moon' ? null : 'full moon only');
  }
}

let server: TestServer;
const moonGames: FullMoonGame[] = [];

beforeAll(async () => {
  server = await startTestServer({
    alpha: stubEntry(),
    beta: stubEntry(),
    moon: stubEntry({
      create: () => {
        const game = new FullMoonGame();
        moonGames.push(game);
        return game;
      },
    }),
  });
});

afterAll(async () => {
  await server.close();
});

describe('GameableColyseusRoom.onAuth', () => {
  it('refuses a join that speaks another protocol version, with the version code', async () => {
    const host = await TestPlayer.create(server.endpoint, 'alpha', { name: 'H' });
    const join = TestPlayer.joinById(server.endpoint, host.room.roomId, {
      name: 'old tab',
      game: 'alpha',
      v: PROTOCOL_VERSION + 1,
    });
    await expect(join).rejects.toMatchObject({ code: 426 });
    await expect(
      TestPlayer.create(server.endpoint, 'alpha', { name: 'old', v: undefined }),
    ).rejects.toMatchObject({ code: 426 });
    expect(localRoom(host.room.roomId).players).toBe(1);
    await host.leave();
  });

  it("refuses a code from another game: a beta page gets no seat in alpha's room", async () => {
    const host = await TestPlayer.create(server.endpoint, 'alpha', { name: 'H' });
    const cross = TestPlayer.joinById(server.endpoint, host.room.roomId, {
      name: 'X',
      game: 'beta',
    });
    await expect(cross).rejects.toThrow(/not found/);
    const unnamed = TestPlayer.joinById(server.endpoint, host.room.roomId, { name: 'Y' });
    await expect(unnamed).rejects.toThrow(/not found/);
    const room = localRoom(host.room.roomId);
    expect(room.players).toBe(1);
    expect((room.game as StubGame).joins).toEqual([{ player: 0, name: 'H' }]);
    const friend = await TestPlayer.joinById(server.endpoint, host.room.roomId, {
      name: 'F',
      game: 'alpha',
    });
    await waitFor(() => friend.replica.welcomes === 1, 'the same-game join');
    await Promise.all([friend.leave(), host.leave()]);
  });

  it("asks the game's admit hook, and a refusal gets no seat (the plan's 'full moon only')", async () => {
    const moon = await TestPlayer.create(server.endpoint, 'moon', { name: 'moon', token: 't-1' });
    const game = moonGames[0];
    expect(game.asked).toEqual([{ name: 'moon', token: 't-1' }]);
    const sun = TestPlayer.joinById(server.endpoint, moon.room.roomId, {
      name: 'sun',
      game: 'moon',
    });
    await expect(sun).rejects.toThrow(/full moon only/);
    expect(game.joins).toEqual([{ player: 0, name: 'moon' }]);
    expect(localRoom(moon.room.roomId).players).toBe(1);
    await moon.leave();
  });
});
