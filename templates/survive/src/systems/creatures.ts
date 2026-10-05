/**
 * The creatures: walk at the nearest camp body, then hit it. Authority only.
 *
 * The FPS template's enemy approach (`templates/fps/src/systems/enemyAI.ts`)
 * with a room's worth of targets: a camp body is any survivor still on their
 * feet, or any wall. Chase it on the flat at `rules.creatureSpeed`, facing the
 * way it walks; inside `rules.creatureReach`, stand and hit it every
 * `rules.creatureHitSeconds` for `rules.creatureDamage`. A survivor at 0 is
 * downed until dawn; a wall at 0 falls.
 */
import { character, Health, Transform, type GameContext } from 'gameable';

import { MAX_SEATS, camp } from '../camp';
import { num } from '../rules';

/** The target this step: an entity, and the player it belongs to (-1 for a wall). */
const target = { entity: 0, player: -1, distance: 0 };
/** Reused payload. */
const downedPayload = { player: 0 };

/**
 * Turn a creature to a yaw about +Y, where 0 faces +Z. A write, not a
 * command: the SDK packs the whole transform row after the systems run.
 *
 * @param e The creature.
 * @param yaw Radians.
 */
function face(e: number, yaw: number): void {
  const half = yaw * 0.5;
  Transform.qx[e] = 0;
  Transform.qy[e] = Math.sin(half);
  Transform.qz[e] = 0;
  Transform.qw[e] = Math.cos(half);
}

/**
 * @param e A creature.
 * @param other A candidate target.
 * @returns The flat distance between them.
 */
function flat(e: number, other: number): number {
  return Math.hypot(Transform.x[other] - Transform.x[e], Transform.z[other] - Transform.z[e]);
}

/**
 * Find the nearest camp body to a creature, into `target`.
 *
 * @param ctx The frame context.
 * @param e The creature.
 * @returns False when there is nothing to go for.
 */
function nearest(ctx: GameContext, e: number): boolean {
  target.entity = 0;
  target.player = -1;
  target.distance = Infinity;
  for (let id = 0; id < MAX_SEATS; id += 1) {
    const body = ctx.playerEntity(id);
    if (body === 0 || camp.downed[id] === 1) continue;
    const d = flat(e, body);
    if (d >= target.distance) continue;
    target.entity = body;
    target.player = id;
    target.distance = d;
  }
  const walls = camp.walls;
  for (let i = 0; i < walls.count; i += 1) {
    const d = flat(e, walls.items[i]);
    if (d >= target.distance) continue;
    target.entity = walls.items[i];
    target.player = -1;
    target.distance = d;
  }
  return target.entity !== 0;
}

/**
 * Hit the target. A survivor at 0 is downed; a wall at 0 falls.
 *
 * @param ctx The frame context.
 */
function hit(ctx: GameContext): void {
  const e = target.entity;
  Health.current[e] = Math.max(0, Health.current[e] - num(ctx.rules.creatureDamage, 10));
  ctx.audio.play('sfx.hit', { entity: e, volume: 0.5 });
  if (Health.current[e] > 0) return;
  if (target.player >= 0) {
    camp.downed[target.player] = 1;
    downedPayload.player = target.player;
    ctx.net.send('downed', downedPayload);
    return;
  }
  const walls = camp.walls;
  for (let i = 0; i < walls.count; i += 1) {
    if (walls.items[i] !== e) continue;
    walls.removeAt(i);
    break;
  }
  ctx.despawn(e);
}

/**
 * The `creatures` system.
 *
 * @param ctx The frame context.
 */
export function creatures(ctx: GameContext): void {
  const speed = num(ctx.rules.creatureSpeed, 2);
  const reach = num(ctx.rules.creatureReach, 1.4);
  const interval = num(ctx.rules.creatureHitSeconds, 1);
  const list = camp.creatures;
  for (let i = 0; i < list.count; i += 1) {
    const e = list.items[i];
    if (camp.cooldown[e] > 0) camp.cooldown[e] -= ctx.dt;
    if (!nearest(ctx, e)) {
      ctx.physics.moveCharacter(e, 0, 0, 0);
      character.setState(e, 'idle', 0, 0, 0, true);
      continue;
    }
    const dx = Transform.x[target.entity] - Transform.x[e];
    const dz = Transform.z[target.entity] - Transform.z[e];
    if (target.distance > reach) {
      const scale = speed / target.distance;
      ctx.physics.moveCharacter(e, dx * scale, 0, dz * scale);
      face(e, Math.atan2(dx, dz));
      character.setState(e, 'walk', dx * scale, 0, dz * scale, true);
      continue;
    }
    ctx.physics.moveCharacter(e, 0, 0, 0);
    face(e, Math.atan2(dx, dz));
    character.setState(e, 'idle', 0, 0, 0, true);
    if (camp.cooldown[e] > 0) continue;
    camp.cooldown[e] = interval;
    hit(ctx);
  }
}
