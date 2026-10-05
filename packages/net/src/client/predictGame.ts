/**
 * A game written the way a predicting game is: one movement system that
 * runs on both sides. On the authority it walks every player's own entity;
 * on a player's page (client role) it walks only that page's player, on a
 * character body the client guest spawns for itself, which the page then
 * predicts. Not exported; the prediction tests run it as a real client guest.
 */
import { defineGame, prefab, type GameContext, type PlayerHandle } from '@gameable/sdk';

/** The walker: an invisible character capsule. */
export const Walker = prefab({
  name: 'walker',
  body: {
    shape: 'capsule',
    dims: [0.3, 0.9],
    kind: 'character',
    mass: 80,
    layer: { player: true },
    mask: { staticGeometry: true },
    flags: { lockRotation: true, noSleep: true },
  },
});

/** The client guest's own body for its player; 0 until its first step. */
let own = 0;
const start = { x: 0, y: 1, z: 0 };

/**
 * @param ctx The frame context.
 * @param entity The body's entity.
 * @param player Whose keys walk it.
 */
function walk(ctx: GameContext, entity: number, player: PlayerHandle): void {
  const move = player.input.axis2('A', 'D', 'S', 'W');
  ctx.physics.moveCharacter(entity, move.x * 4, 0, -move.y * 4);
}

/**
 * Movement, on both sides.
 *
 * @param ctx The frame context.
 */
function movement(ctx: GameContext): void {
  if (ctx.net.role === 'client') {
    const me = ctx.localPlayer;
    if (me === null) return;
    if (own === 0) own = ctx.spawn(Walker, start); // a local entity: never the authority's
    walk(ctx, own, me);
    return;
  }
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].entity !== 0) walk(ctx, list[i].entity, list[i]);
  }
}

export default defineGame({
  features: { multiplayer: { maxPlayers: 4, predict: true } },
  player: { prefab: Walker, spawn: [0, 1, 0] },
  init: () => {
    own = 0;
  },
  systems: [{ on: 'both', run: movement }],
});
