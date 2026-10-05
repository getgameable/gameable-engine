/**
 * Eggs, pets, coins and combining, driven headlessly as a room's authority
 * over a memory store (`tests/room.ts`).
 */
import { createRng, RigidBody } from 'gameable';
import { describe, expect, it } from 'vitest';

import { collection, VISIBLE_PETS } from '../src/collection';
import game from '../src/game';
import { drawKind, PET_KINDS, type CollectDoc } from '../src/pets';
import { bootRoom, GAME, sends, type TestRoom } from './room';

/** Coins out of reach unless a test wants them; a one-second hatch. */
const QUIET = { coinRange: -1, hatchSeconds: 1 };

/**
 * @param room The room.
 * @param key A store key.
 * @param doc The document to start them with.
 */
async function seed(room: TestRoom, key: string, doc: CollectDoc): Promise<void> {
  await room.store.save(GAME, key, JSON.stringify(doc), 0);
}

/**
 * @param n How many.
 * @param kind Their kind.
 * @param tier Their tier.
 * @returns `n` pets with ids `<kind><i>`.
 */
function pets(n: number, kind = 'cat', tier = 1): CollectDoc['pets'] {
  return Array.from({ length: n }, (_, i) => ({ id: `${kind}${String(i)}`, kind, tier }));
}

describe('the room', () => {
  it('seats up to eight and says "open" in the room list', async () => {
    expect(game.features?.multiplayer).toEqual({ maxPlayers: 8 });
    const room = bootRoom(QUIET);
    await room.join(0, 'ann');
    const r = room.run(2);
    expect(sends(r, 'aos:phase').map((s) => s.payload)).toEqual(['open']);
  });

  it('gives a new player an empty document, saved to the store', async () => {
    const room = bootRoom(QUIET);
    await room.join(0, 'ann');
    room.run(1);
    expect(await room.stored('ann')).toEqual({ bucks: 0, pets: [], eggs: [] });
  });
});

describe('eggs', () => {
  it('buy takes the bucks; the egg hatches after its timer into a pet drawn on the authority', async () => {
    const room = bootRoom(QUIET);
    await seed(room, 'ann', { bucks: 30, pets: [], eggs: [] });
    await room.join(0, 'ann');
    room.run(2, (frame, tape) => {
      if (frame === 0) tape.message(0, 'buy');
    });
    const bought = await room.stored('ann');
    expect(bought?.bucks).toBe(5);
    expect(bought?.eggs).toHaveLength(1);
    expect(bought?.pets).toEqual([]);

    const r = room.run(70);
    const doc = await room.stored('ann');
    expect(doc?.eggs).toEqual([]);
    expect(doc?.pets).toHaveLength(1);
    const pet = doc?.pets[0];
    expect(PET_KINDS.map((k) => k.kind)).toContain(pet?.kind);
    expect(pet?.tier).toBe(1);
    expect(sends(r, 'hatched')).toEqual([{ to: 0, payload: pet }]);
  });

  it('the same seed hatches the same pet: the draw is ctx.rng, not chance', async () => {
    const hatchOne = async (): Promise<unknown> => {
      const room = bootRoom(QUIET, 77);
      await seed(room, 'ann', { bucks: 0, pets: [], eggs: [{ kind: 'basic', hatchAt: 0 }] });
      await room.join(0, 'ann');
      room.run(3);
      return (await room.stored('ann'))?.pets;
    };
    expect(await hatchOne()).toEqual(await hatchOne());
  });

  it('draws kinds by weight, rarest last', () => {
    const fixed = (value: number) => ({ ...createRng(1), float: () => value });
    expect(drawKind(fixed(0))).toBe('cat');
    expect(drawKind(fixed(0.7))).toBe('dog');
    expect(drawKind(fixed(0.995))).toBe('dragon');
  });

  it('an egg from another room waits at most hatchSeconds after the join', async () => {
    const room = bootRoom({ ...QUIET, hatchSeconds: 2 });
    await seed(room, 'ann', { bucks: 0, pets: [], eggs: [{ kind: 'basic', hatchAt: 9999 }] });
    await room.join(0, 'ann');
    room.run(1);
    expect((await room.stored('ann'))?.eggs).toEqual([{ kind: 'basic', hatchAt: 2 }]);
    room.run(125);
    expect((await room.stored('ann'))?.pets).toHaveLength(1);
  });

  it('refuses an egg without the bucks', async () => {
    const room = bootRoom(QUIET);
    await room.join(0, 'ann');
    const r = room.run(2, (frame, tape) => {
      if (frame === 1) tape.message(0, 'buy');
    });
    expect(sends(r, 'refused')).toEqual([{ to: 0, payload: { what: 'buy', reason: 'short' } }]);
    expect((await room.stored('ann'))?.eggs).toEqual([]);
  });
});

describe('pets', () => {
  it('the newest three follow their owner', async () => {
    const room = bootRoom({ ...QUIET, petFollow: 60 });
    await seed(room, 'ann', { bucks: 0, pets: pets(5), eggs: [] });
    await room.join(0, 'ann');
    room.run(2);
    const shown = Array.from(collection.petEntity.slice(0, VISIBLE_PETS));
    expect(shown.every((e) => e !== 0)).toBe(true);
    expect(collection.petEntity[VISIBLE_PETS]).toBe(0); // nobody in seat 1
    expect(collection.petShown.slice(0, VISIBLE_PETS)).toEqual(['cat4', 'cat3', 'cat2']);

    room.place(room.tape.entityOf(0), 6, -4);
    const r = room.run(3);
    const body = RigidBody.handle[shown[2]];
    const moves = r.commands
      .flat()
      .filter((c) => c.tag === 'set-body-transform' && c.val.body === body);
    const last = moves.at(-1);
    const at = last?.tag === 'set-body-transform' ? last.val : undefined;
    // Slot 2 stands 1.3 m behind (+z) its owner.
    expect(at?.position.x).toBeCloseTo(6, 3);
    expect(at?.position.z).toBeCloseTo(-2.7, 3);
    expect(at?.teleport).toBe(false);
  });

  it('a leaving player takes their pets with them', async () => {
    const room = bootRoom(QUIET);
    await seed(room, 'ann', { bucks: 0, pets: pets(2), eggs: [] });
    await room.join(0, 'ann');
    room.run(2);
    const pet = collection.petEntity[0];
    room.tape.leave(0);
    const r = room.run(1);
    expect(r.commands.flat()).toContainEqual({ tag: 'despawn', val: pet });
    expect(collection.petEntity[0]).toBe(0);
  });
});

describe('coins', () => {
  it('walking over a coin pays coinValue bucks, and the coin moves on', async () => {
    const room = bootRoom({ ...QUIET, coinRange: 0.5 });
    await room.join(0, 'ann');
    room.run(1);
    const [x, z] = [collection.coinX[0], collection.coinZ[0]];
    room.place(room.tape.entityOf(0), x, z);
    const r = room.run(2);
    expect((await room.stored('ann'))?.bucks).toBe(5);
    expect(sends(r, 'coin')).toEqual([{ to: 0, payload: { bucks: 5 } }]);
    expect(collection.coinX[0] !== x || collection.coinZ[0] !== z).toBe(true);
  });
});

describe('combine', () => {
  it('four identical pets become one of the next tier; three are not enough', async () => {
    const room = bootRoom(QUIET);
    const mixed = [...pets(4), ...pets(3, 'dog')];
    await seed(room, 'ann', { bucks: 0, pets: mixed, eggs: [] });
    await room.join(0, 'ann');
    room.run(2, (frame, tape) => {
      if (frame === 1) tape.message(0, 'combine', JSON.stringify({ kind: 'cat', tier: 1 }));
    });
    const doc = await room.stored('ann');
    expect(doc?.pets.filter((p) => p.kind === 'cat')).toEqual([
      { id: expect.any(String) as string, kind: 'cat', tier: 2 },
    ]);
    expect(doc?.pets.filter((p) => p.kind === 'dog')).toHaveLength(3);

    const r = room.run(2, (frame, tape) => {
      if (frame === 0) tape.message(0, 'combine', JSON.stringify({ kind: 'dog', tier: 1 }));
    });
    expect(sends(r, 'refused')).toEqual([
      { to: 0, payload: { what: 'combine', reason: 'need-four' } },
    ]);
    expect((await room.stored('ann'))?.pets).toHaveLength(4);
  });

  it('combine with no payload finds the first four itself', async () => {
    const room = bootRoom(QUIET);
    await seed(room, 'ann', {
      bucks: 0,
      pets: [...pets(2, 'dog'), ...pets(4, 'cat', 2)],
      eggs: [],
    });
    await room.join(0, 'ann');
    room.run(2, (frame, tape) => {
      if (frame === 1) tape.message(0, 'combine');
    });
    const doc = await room.stored('ann');
    expect(doc?.pets.map((p) => `${p.kind}${String(p.tier)}`)).toEqual(['dog1', 'dog1', 'cat3']);
  });
});
