/**
 * Task 5.3: who joins. `GameableColyseusRoom.onAuth` asks the room's
 * `Identities` (the portal by cookie or bearer, then the device token), the
 * seat keeps the identity for the game (Task 5.2's store key), a portal
 * user's name wins over the typed one, and a page with no valid device
 * token gets a fresh one on the `IDENTITY_TYPE` message.
 */
import { createIdentities, deviceIdentity, portalIdentity } from '@gameable/net/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { StubGame, stubEntry } from './testing/StubGame.js';
import { TestPlayer } from './testing/TestPlayer.js';
import { localRoom, startTestServer, type TestServer, waitFor } from './testing/testServer.js';

const SECRET = 'a-test-secret-that-is-32-bytes-ok';
/** /auth/me: the `good` session is Ana; anything else is a 401. */
const authMe = vi.fn((_url: string, init?: RequestInit) => {
  const cookie = new Headers(init?.headers).get('cookie');
  return Promise.resolve(
    cookie === 'avataros_session=good'
      ? new Response(JSON.stringify({ id: 'user-ana', email: 'ana@gameable.test' }), {
          status: 200,
        })
      : new Response('{"error":"Unauthorized"}', { status: 401 }),
  );
});

/** A game that records the names its admit hook is asked about. */
class GateGame extends StubGame {
  readonly asked: string[] = [];

  admit(name: string): Promise<string | null> {
    this.asked.push(name);
    return Promise.resolve(null);
  }
}

const gateGames: GateGame[] = [];
let server: TestServer;

beforeAll(async () => {
  const identities = createIdentities({
    device: deviceIdentity(SECRET),
    portal: portalIdentity({ authUrl: 'https://auth.test', fetch: authMe }),
  });
  const gate = stubEntry({
    create: () => {
      const game = new GateGame();
      gateGames.push(game);
      return game;
    },
  });
  server = await startTestServer({ alpha: stubEntry({ maxPlayers: 4 }), gate }, { identities });
});

afterAll(async () => {
  await server.close();
});

/**
 * @param player A joined player.
 * @returns The device token the room handed it, once it arrives.
 */
async function tokenOf(player: TestPlayer): Promise<string> {
  await waitFor(() => player.identityTokens.length > 0, 'the identity message');
  return player.identityTokens[0];
}

/**
 * @param player A joined player.
 * @returns Its seat in its room.
 */
function seatOf(player: TestPlayer) {
  const seat = localRoom(player.room.roomId).seats.get(player.room.sessionId);
  if (seat === undefined) throw new Error('no seat');
  return seat;
}

describe('GameableColyseusRoom: identity', () => {
  it('a first join gets a device token; a reload that sends it back is the same id', async () => {
    const first = await TestPlayer.create(server.endpoint, 'alpha', { name: 'Gus' });
    const token = await tokenOf(first);
    expect(token).toMatch(/^device\./);
    const id = seatOf(first).identity?.id ?? '';
    expect(id).toMatch(/^device:/);
    await first.leave(); // the room goes with its last player: the reload makes a new one
    const reload = await TestPlayer.create(server.endpoint, 'alpha', {
      name: 'Gus',
      device: token,
    });
    await waitFor(() => reload.replica.welcomes === 1, 'the welcome');
    expect(seatOf(reload).identity?.id).toBe(id);
    expect(reload.identityTokens).toEqual([]); // a valid token is not replaced
    await reload.leave();
  });

  it('two tabs with the same device token: the same id, two seats', async () => {
    const host = await TestPlayer.create(server.endpoint, 'alpha', { name: 'Host' });
    const token = await tokenOf(host);
    const tab = await TestPlayer.joinById(server.endpoint, host.room.roomId, {
      name: 'Tab',
      game: 'alpha',
      device: token,
    });
    await waitFor(() => tab.replica.welcomes === 1, 'the second tab');
    const [a, b] = [seatOf(host), seatOf(tab)];
    expect(b.identity?.id).toBe(a.identity?.id);
    expect(b.player.id).not.toBe(a.player.id);
    const game = localRoom(host.room.roomId).game as StubGame;
    expect(game.identities.map((who) => who?.id)).toEqual([a.identity?.id, a.identity?.id]);
    await Promise.all([tab.leave(), host.leave()]);
  });

  it('a forged token is refused: the player gets a fresh device id, never the one it names', async () => {
    const real = await TestPlayer.create(server.endpoint, 'alpha', { name: 'Real' });
    const token = await tokenOf(real);
    const forged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const faker = await TestPlayer.joinById(server.endpoint, real.room.roomId, {
      name: 'Faker',
      game: 'alpha',
      device: forged,
    });
    const fresh = await tokenOf(faker);
    expect(fresh).not.toBe(token);
    expect(seatOf(faker).identity?.id).not.toBe(seatOf(real).identity?.id);
    await Promise.all([faker.leave(), real.leave()]);
  });

  it("a signed-in player is the portal user, and the portal's name wins over the typed one", async () => {
    const ana = await TestPlayer.create(
      server.endpoint,
      'alpha',
      { name: 'Mallory' },
      { cookie: 'theme=dark; avataros_session=good' },
    );
    expect(seatOf(ana).identity).toEqual({ id: 'user-ana', name: 'ana', kind: 'portal' });
    expect(seatOf(ana).player.name).toBe('ana');
    const game = localRoom(ana.room.roomId).game as StubGame;
    expect(game.joins).toEqual([{ player: 0, name: 'ana' }]);
    // A bearer token in the join options does the same for a page off the auth service's cookie domain.
    const bearer = await TestPlayer.joinById(server.endpoint, ana.room.roomId, {
      name: 'Eve',
      game: 'alpha',
      portal: 'good',
    });
    expect(seatOf(bearer).identity?.id).toBe('user-ana');
    expect(seatOf(bearer).player.name).toBe('ana');
    await Promise.all([bearer.leave(), ana.leave()]);
  });

  it('a portal 401 falls through to the device token; a guest keeps its typed name, capped', async () => {
    const guest = await TestPlayer.create(
      server.endpoint,
      'alpha',
      { name: 'G'.repeat(50) },
      { cookie: 'avataros_session=expired' },
    );
    const token = await tokenOf(guest);
    expect(seatOf(guest).identity?.kind).toBe('device');
    expect(seatOf(guest).player.name).toBe('G'.repeat(32));
    const again = await TestPlayer.joinById(
      server.endpoint,
      guest.room.roomId,
      { name: 'Gina', game: 'alpha', device: token },
      { cookie: 'avataros_session=expired' },
    );
    expect(seatOf(again).identity?.id).toBe(seatOf(guest).identity?.id);
    expect(seatOf(again).player.name).toBe('Gina');
    await Promise.all([again.leave(), guest.leave()]);
  });

  it("the game's admit hook hears the resolved name, not the typed one", async () => {
    const ana = await TestPlayer.create(
      server.endpoint,
      'gate',
      { name: 'Mallory' },
      { cookie: 'avataros_session=good' },
    );
    expect(gateGames[0].asked).toEqual(['ana']);
    await ana.leave();
  });
});
