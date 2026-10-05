/**
 * Gathering and building. Authority only: the authority holds the wood, so a
 * page can ask for a wall but never mint one.
 *
 * - `gather` within `rules.gatherRange` of a tree adds `rules.woodPerGather`.
 * - `build` with at least `rules.wallCost` wood puts a wall up
 *   `rules.buildDistance` in front of the player, square to where they look.
 *
 * A downed player does neither. Each change of a player's wood is sent to
 * that player alone as `wood`.
 */
import { query, Transform, type GameContext } from 'gameable';

import { camp, MAX_SEATS } from '../camp';
import { Build, Gather } from '../messages';
import { Choppable, COLOURS, Wall, WALL_HALF, tint } from '../prefabs';
import { num } from '../rules';

/** Query terms, hoisted: a fresh array every tick is an allocation. */
const TREES = [Choppable, Transform];
/** Reused spawn point and rotation. */
const at = { x: 0, y: WALL_HALF[1], z: 0 };
const turn = { x: 0, y: 0, z: 0, w: 1 };
/** Reused payload and options. */
const woodPayload = { wood: 0 };
const toOne = { to: 0 };

/**
 * @param ctx The frame context.
 * @param player A sender.
 * @returns Their entity, or 0 for nobody (or a downed player).
 */
function worker(ctx: GameContext, player: number): number {
  if (player < 0 || player >= MAX_SEATS || camp.downed[player] === 1) return 0;
  return ctx.playerEntity(player);
}

/**
 * @param ctx The frame context.
 * @param player Whose wood changed.
 */
function tell(ctx: GameContext, player: number): void {
  woodPayload.wood = camp.wood[player];
  toOne.to = player;
  ctx.net.send('wood', woodPayload, toOne);
}

/**
 * @param ctx The frame context.
 * @param entity A survivor.
 * @returns True when a tree stands within `rules.gatherRange`.
 */
function besideTree(ctx: GameContext, entity: number): boolean {
  const range = num(ctx.rules.gatherRange, 1.8);
  const trees = query(ctx.world, TREES);
  for (let i = 0; i < trees.length; i += 1) {
    const t = trees[i];
    const d = Math.hypot(
      Transform.x[t] - Transform.x[entity],
      Transform.z[t] - Transform.z[entity],
    );
    if (d <= range) return true;
  }
  return false;
}

/**
 * Put a wall up in front of a player.
 *
 * @param ctx The frame context.
 * @param player The builder.
 * @param entity Their survivor.
 */
function raise(ctx: GameContext, player: number, entity: number): void {
  // Forward is away from the camera: W walks along (-sin yaw, -cos yaw).
  const yaw = ctx.players.get(player)?.camera.look.yaw ?? 0;
  const distance = num(ctx.rules.buildDistance, 1.5);
  at.x = Transform.x[entity] - Math.sin(yaw) * distance;
  at.z = Transform.z[entity] - Math.cos(yaw) * distance;
  turn.y = Math.sin(yaw * 0.5);
  turn.w = Math.cos(yaw * 0.5);
  const wall = ctx.spawn(Wall, at, turn);
  tint(wall, COLOURS.wall);
  camp.walls.add(wall);
}

/**
 * The `work` system.
 *
 * @param ctx The frame context.
 */
export function work(ctx: GameContext): void {
  const gathers = ctx.net.messages(Gather);
  for (let i = 0; i < gathers.length; i += 1) {
    const player = gathers[i].player;
    const entity = worker(ctx, player);
    if (entity === 0 || !besideTree(ctx, entity)) continue;
    camp.wood[player] += num(ctx.rules.woodPerGather, 1);
    tell(ctx, player);
  }
  const cost = num(ctx.rules.wallCost, 2);
  const builds = ctx.net.messages(Build);
  for (let i = 0; i < builds.length; i += 1) {
    const player = builds[i].player;
    const entity = worker(ctx, player);
    if (entity === 0 || camp.wood[player] < cost) continue;
    if (camp.walls.count >= camp.walls.items.length) continue;
    camp.wood[player] -= cost;
    raise(ctx, player, entity);
    tell(ctx, player);
  }
}
