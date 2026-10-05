/**
 * Movement, on both sides (`on: 'both'`), so a player's own page can predict
 * it (`features.multiplayer.predict`).
 *
 * - On the **authority** it walks every fighter from their own keys, adds
 *   their dash and their knockback, turns them to face where they go, and
 *   tells the animator.
 * - On a player's **page** it walks only `ctx.localPlayer`, on an invisible
 *   body the page spawns for itself (`OwnBody`). The page moves that body on
 *   the step the key goes down and draws this player there; the authority's
 *   position corrects it. Dash and knockback are the authority's alone, so
 *   they reach the page as corrections.
 *
 * WASD are world axes under the fixed arena camera: W is away from it (-Z).
 * Both sides must move the body exactly the same way from the same keys.
 */
import {
  markMoved,
  Transform,
  TRANSFORM_FLAGS,
  type GameContext,
  type PlayerHandle,
} from 'gameable';

import { fight, MAX_PLAYERS, num, SPAWNS } from '../fight';
import { OwnBody } from '../prefabs';

/** The page's own body for its player; 0 until its first step. */
let own = 0;
/** Reused spawn position for the own body. */
const start = { x: 0, y: 0, z: 0 };
/** Reused: the walk velocity `walkVelocity` writes. */
const walk = { x: 0, z: 0 };

/** Forget the page's own body. Call from `defineGame({ init })`. */
export function resetMove(): void {
  own = 0;
}

/**
 * The walk velocity from a player's keys, into `walk`. The same on both sides.
 *
 * @param ctx The frame context.
 * @param player Whose keys.
 * @param frozen True while knocked out: no walking.
 */
function walkVelocity(ctx: GameContext, player: PlayerHandle, frozen: boolean): void {
  const move = player.input.axis2('A', 'D', 'S', 'W');
  const length = frozen ? 0 : Math.hypot(move.x, move.y);
  const speed = num(ctx.rules.walkSpeed, 4.5);
  walk.x = length > 0 ? (move.x / length) * speed : 0;
  walk.z = length > 0 ? (-move.y / length) * speed : 0;
}

/**
 * One fighter on the authority: walk, dash, knockback, facing, animation.
 *
 * @param ctx The frame context.
 * @param player The fighter's player.
 */
function driveFighter(ctx: GameContext, player: PlayerHandle): void {
  const seat = player.id;
  const entity = player.entity;
  const out = fight.out[seat] === 1;
  walkVelocity(ctx, player, out);
  if (walk.x !== 0 || walk.z !== 0) {
    const length = Math.hypot(walk.x, walk.z);
    fight.faceX[seat] = walk.x / length;
    fight.faceZ[seat] = walk.z / length;
  }
  let vx = walk.x + fight.knockX[seat];
  let vz = walk.z + fight.knockZ[seat];
  if (fight.dashing[seat] > 0) {
    const dash = num(ctx.rules.dashSpeed, 14);
    vx = fight.faceX[seat] * dash + fight.knockX[seat];
    vz = fight.faceZ[seat] * dash + fight.knockZ[seat];
    fight.dashing[seat] = Math.max(0, fight.dashing[seat] - ctx.dt);
  }
  // Knockback fades out: a fraction of it is lost every second.
  const keep = Math.max(0, 1 - num(ctx.rules.knockbackDecay, 6) * ctx.dt);
  fight.knockX[seat] *= keep;
  fight.knockZ[seat] *= keep;
  ctx.physics.moveCharacter(entity, vx, 0, vz, false);

  const half = Math.atan2(fight.faceX[seat], fight.faceZ[seat]) * 0.5;
  Transform.qx[entity] = Transform.qz[entity] = 0;
  Transform.qy[entity] = Math.sin(half);
  Transform.qw[entity] = Math.cos(half);
  markMoved(entity, TRANSFORM_FLAGS.ROTATION);
  const state = out ? 'idle' : walk.x !== 0 || walk.z !== 0 ? 'run' : 'idle';
  ctx.character.setState(entity, state, vx, 0, vz, true);
}

/**
 * The `move` system.
 *
 * @param ctx The frame context.
 */
export function move(ctx: GameContext): void {
  if (ctx.net.role === 'client') {
    const me = ctx.localPlayer;
    if (me === null || me.id >= MAX_PLAYERS) return;
    if (own === 0) {
      const at = SPAWNS[me.id];
      start.x = at[0];
      start.y = at[1];
      start.z = at[2];
      own = ctx.spawn(OwnBody, start); // this page's own, never the authority's
    }
    walkVelocity(ctx, me, fight.out[me.id] === 1);
    ctx.physics.moveCharacter(own, walk.x, 0, walk.z, false);
    return;
  }
  const list = ctx.players.list;
  for (let i = 0; i < list.length; i += 1) {
    const player = list[i];
    if (player.entity !== 0 && player.id < MAX_PLAYERS) driveFighter(ctx, player);
  }
}
