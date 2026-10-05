/**
 * Player data through a real guest: the room loads a joining player's
 * document, the guest's `ctx.data` saves and trades through the store, and a
 * store that refuses never stops the room.
 */
import { defineGame, type GameContext } from '@gameable/sdk';
import { describe, expect, it } from 'vitest';

import type { PlayerIdentity } from '../identity/index.js';
import { memoryStore, type PlayerStore } from '../store/index.js';
import { createEngineRoomGame } from './createEngineRoomGame.js';
import type { EngineRoomGame } from './EngineRoomGame.js';

const MANIFEST = { version: 1, assets: [] };
const MS = 1000 / 60;

/**
 * @param id The store key.
 * @returns A portal identity with this id.
 */
const who = (id: string): PlayerIdentity => ({ id, name: id, kind: 'portal' });

/** Let the store's promises settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

interface Rig {
  game: EngineRoomGame;
  store: PlayerStore;
  logs: string[];
  /** Every exchange result the guest has seen, in order. */
  results: { id: number; ok: boolean; reason: string }[];
  /** The context the guest's last update saw. */
  ctx: () => GameContext;
  /** Run `act` inside the guest's next update, then tick a few steps. */
  run: (act?: (ctx: GameContext) => void) => Promise<void>;
}

/**
 * A four-seat room over a memory store, the guest's context captured.
 *
 * @param store The store, a fresh memory store by default.
 * @returns The rig.
 */
async function rig(store: PlayerStore = memoryStore()): Promise<Rig> {
  let last: GameContext | null = null;
  let pending: ((ctx: GameContext) => void) | null = null;
  const results: Rig['results'] = [];
  const definition = defineGame({
    features: { multiplayer: { maxPlayers: 4 } },
    update: (ctx) => {
      last = ctx;
      for (const x of ctx.data.results()) results.push({ ...x });
      const act = pending;
      pending = null;
      act?.(ctx);
    },
  });
  const logs: string[] = [];
  const game = await createEngineRoomGame({
    definition,
    manifest: MANIFEST,
    seed: 7,
    data: { store, game: 'steal', log: (line) => logs.push(line) },
  });
  let t = 0;
  return {
    game,
    store,
    logs,
    results,
    ctx: () => {
      if (last === null) throw new Error('no tick ran');
      return last;
    },
    run: async (act) => {
      pending = act ?? null;
      for (let i = 0; i < 3; i += 1) {
        await settle();
        t += 1;
        game.tick(t * MS);
      }
      await settle();
    },
  };
}

describe('EngineRoomGame: player data', () => {
  it('a joining player sees their saved document; a rejoin sees what they saved', async () => {
    const store = memoryStore();
    await store.save('steal', 'u1', '{"coins":10}', 0);
    const r = await rig(store);
    r.game.join(0, 'Ana', null, who('u1'));
    await r.run();
    expect(r.ctx().players.get(0)?.data).toEqual({ coins: 10 });
    expect(typeof r.ctx().players.get(0)?.savedAt).toBe('number');

    await r.run((ctx) => {
      ctx.data.save(0, { coins: 11 });
    });
    await r.run((ctx) => {
      ctx.data.save(0, { coins: 12 });
    }); // throttled: written on leave
    r.game.leave(0, 'left');
    await r.run();
    r.game.join(2, 'Ana', null, who('u1'));
    await r.run();
    expect(r.ctx().players.get(2)?.data).toEqual({ coins: 12 });
    r.game.dispose();
    await r.game.disposed;
  }, 60_000);

  it('an exchange through the room is all-or-nothing, and its result names the id', async () => {
    const store = memoryStore();
    await store.save('steal', 'u1', '{"coins":10}', 0);
    await store.save('steal', 'u2', '{"owned":["gem"]}', 0);
    const r = await rig(store);
    r.game.join(0, 'Ana', null, who('u1'));
    r.game.join(1, 'Ben', null, who('u2'));
    await r.run();

    let id = 0;
    await r.run((ctx) => {
      id = ctx.data.exchange(0, 1, { coins: 4 }, { owned: ['gem'] });
    });
    await r.run();
    expect(r.results).toEqual([{ id, ok: true, reason: '' }]);
    expect(r.ctx().players.get(0)?.data).toEqual({ coins: 6, owned: ['gem'] });
    expect(JSON.parse((await store.load('steal', 'u2'))?.data ?? '')).toEqual({
      owned: [],
      coins: 4,
    });

    let refused = 0;
    await r.run((ctx) => {
      refused = ctx.data.exchange(0, 1, { coins: 1 }, { owned: ['gem'] }); // u2 has none left
    });
    await r.run();
    expect(r.results[1]).toEqual({ id: refused, ok: false, reason: 'refused' });
    expect(JSON.parse((await store.load('steal', 'u1'))?.data ?? '')).toEqual({
      coins: 6,
      owned: ['gem'],
    });
    expect(r.ctx().players.get(1)?.data).toEqual({ owned: [], coins: 4 });
    r.game.dispose();
    await r.game.disposed;
  }, 60_000);

  it('a stale save is logged and the room keeps going', async () => {
    const r = await rig();
    r.game.join(0, 'Ana', null, who('u1'));
    await r.run();
    await r.store.save('steal', 'u1', '{"other":"room"}', 0);
    await r.run((ctx) => {
      ctx.data.save(0, { coins: 1 });
    });
    expect(r.logs.some((l) => l.includes('stale'))).toBe(true);
    const frame = r.game.frame;
    await r.run();
    expect(r.game.frame).toBeGreaterThan(frame);
    expect(r.game.ended).toBeNull();
    r.game.dispose();
    await r.game.disposed;
  }, 60_000);

  it('without an identity (Play Solo) each seat keeps its own document, and dispose flushes it', async () => {
    const r = await rig();
    r.game.join(0, 'You', null);
    await r.run();
    await r.run((ctx) => {
      ctx.data.save(0, { coins: 1 });
    });
    await r.run((ctx) => {
      ctx.data.save(0, { coins: 2 });
    });
    await r.run((ctx) => {
      ctx.data.saveGame({ round: 1 });
    });
    r.game.dispose();
    await r.game.disposed;
    expect((await r.store.load('steal', 'seat-0'))?.data).toBe('{"coins":2}');
    expect((await r.store.loadGame('steal'))?.data).toBe('{"round":1}');
  }, 60_000);
});
