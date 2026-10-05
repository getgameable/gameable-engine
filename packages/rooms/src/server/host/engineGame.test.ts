import type * as NetServer from '@gameable/net/server';
import type { GameDefinition } from '@gameable/sdk';
import { describe, expect, it, vi } from 'vitest';

import { buildRoomParts } from '../RoomParts.js';
import { StubGame } from '../testing/StubGame.js';
import { engineGame } from './engineGame.js';
import { createRoomCatalog } from './RoomCatalog.js';

const calls: NetServer.EngineRoomGameOptions[] = [];
vi.mock('@gameable/net/server', async (original) => ({
  ...(await original<typeof NetServer>()),
  createEngineRoomGame: (options: NetServer.EngineRoomGameOptions) => {
    calls.push(options);
    return Promise.resolve(new StubGame());
  },
}));

const declaring = (maxPlayers?: number): GameDefinition =>
  ({ features: { multiplayer: maxPlayers === undefined ? true : { maxPlayers } } });

describe('engineGame', () => {
  it("takes its seats from roomSeats(definition) and passes them on, in direct mode", async () => {
    calls.length = 0;
    const definition = declaring(3);
    const catalog = createRoomCatalog({ party: engineGame({ definition, manifest: 'm.json', seed: 7 }) });
    const entry = catalog.entry('party');
    expect(entry.maxPlayers).toBe(3);
    expect(catalog.directNames()).toEqual(['party']); // no guest: this JS realm
    await entry.create();
    expect(calls).toEqual([{ definition, manifest: 'm.json', seed: 7, maxPlayers: 3 }]);
  });

  it('gives a wasm guest the seats explicitly and never the definition as well', async () => {
    calls.length = 0;
    const guest = { core: 'game.wasm' } as unknown as NetServer.WasmGuest;
    const catalog = createRoomCatalog({ w: engineGame({ definition: declaring(5), guest }) });
    expect(catalog.directNames()).toEqual([]);
    const entry = catalog.entry('w');
    await entry.create();
    expect(calls).toEqual([{ guest, maxPlayers: 5 }]);
  });

  it('seats DEFAULT_ROOM_SEATS (8) for `multiplayer: true`', () => {
    expect(engineGame({ definition: declaring() }).maxPlayers).toBe(8);
  });

  it("sends rows at the game's own features.multiplayer.sendHz, which the option overrides", () => {
    const definition: GameDefinition = { features: { multiplayer: { sendHz: 10 } } };
    expect(engineGame({ definition }).sendHz).toBe(10);
    expect(engineGame({ definition: declaring() }).sendHz).toBe(20);
    expect(engineGame({ definition, sendHz: 30 }).sendHz).toBe(30);
    expect(() => engineGame({ definition: { features: { multiplayer: { sendHz: 90 } } } })).toThrow(RangeError);
  });

  it('calls a seed function once per room, so every room rolls its own', async () => {
    calls.length = 0;
    let next = 100;
    const game = engineGame({ definition: declaring(2), seed: () => (next += 1) });
    await game.create({ maxPlayers: 2 });
    await game.create({ maxPlayers: 2 });
    expect(calls.map((c) => c.seed)).toEqual([101, 102]);
  });
});

describe('buildRoomParts', () => {
  it("refuses a game whose own seats disagree with the room's", async () => {
    class SixSeats extends StubGame {
      override get maxPlayers(): number {
        return 6;
      }
    }
    const entry = { maxPlayers: 4, create: () => new SixSeats() };
    await expect(buildRoomParts(entry, new Map())).rejects.toThrow(/6 seats.*4/);
    const agrees = { maxPlayers: 6, create: () => new SixSeats() };
    await expect(buildRoomParts(agrees, new Map())).resolves.toMatchObject({ seats: { size: 0 } });
  });
});
