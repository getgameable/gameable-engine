/**
 * The enemies: idle until they see you, chase you, then hit you.
 *
 * Three states and one timer each, held in flat typed arrays indexed by entity
 * id. That is what a component is in this ECS — the arrays do not have to be
 * registered with bitecs to be written, they only have to be long enough.
 *
 * Each enemy publishes two things a body needs and a capsule did not: a
 * `character.setState` with its velocity, which the host's animator blends
 * idle, walk and run from, and a yaw written straight into `Transform`, so an
 * enemy walks forwards and swings at you face on.
 */
import { character, Enemy, Health, query, Transform, type GameContext } from 'gameable';

import { ENEMY_CENTRE, PLAYER_CENTRE } from '../prefabs';

/** Entity ceiling; must match `world.maxEntities` in `src/game.ts`. */
const MAX_ENTITIES = 512;

/** What an enemy is doing. */
export const AI_IDLE = 0;
/** Walking towards the player. */
export const AI_CHASE = 1;
/** Close enough to swing. */
export const AI_ATTACK = 2;

/** One lane per enemy: the state it is in. */
export const aiMode = new Uint8Array(MAX_ENTITIES);

/** One lane per enemy: seconds until it may attack again. */
export const aiCooldown = new Float32Array(MAX_ENTITIES);

/** Query terms, hoisted: a fresh array every frame is a per-frame allocation. */
const ENEMIES = [Enemy, Transform, Health];

/** The state name each `AI_*` mode reports, indexed by the mode. */
const AI_STATE_NAMES = ['idle', 'chase', 'attack'] as const;

/**
 * Clear every enemy's state. Call from `defineGame({ init })`.
 *
 * @returns Nothing.
 */
export function resetEnemyAI(): void {
  aiMode.fill(0);
  aiCooldown.fill(0);
}

/**
 * Turn an enemy to a yaw about `+Y`, where `0` faces `+Z`.
 *
 * No command and no allocation: the host dirtied this entity's row when it sent
 * the body back this step, and the SDK packs the whole row — rotation included
 * — once the systems have run.
 *
 * @param e The enemy entity.
 * @param yaw Where to look, radians.
 * @returns Nothing.
 */
function face(e: number, yaw: number): void {
  const half = yaw * 0.5;
  Transform.qx[e] = 0;
  Transform.qy[e] = Math.sin(half);
  Transform.qz[e] = 0;
  Transform.qw[e] = Math.cos(half);
}

/**
 * Run every enemy for one fixed step.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function enemyAI(ctx: GameContext): void {
  const player = ctx.player;
  if (player === 0) return;

  const speed = Number(ctx.rules.enemySpeed ?? 2.2);
  const sight = Number(ctx.rules.enemySight ?? 14);
  const reach = Number(ctx.rules.enemyReach ?? 1.5);
  const damage = Number(ctx.rules.enemyDamage ?? 6);
  const interval = Number(ctx.rules.enemyAttackInterval ?? 1.4);
  const playerAlive = (Health.current[player] ?? 0) > 0;

  const px = Transform.x[player] ?? 0;
  const pz = Transform.z[player] ?? 0;

  const entities = query(ctx.world, ENEMIES);
  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i] ?? 0;
    if (e === 0) continue;

    if ((Health.current[e] ?? 0) <= 0) {
      // Dead: the host drops the body and the mesh with the entity.
      ctx.despawn(e);
      continue;
    }

    if (aiCooldown[e] > 0) aiCooldown[e] -= ctx.dt;

    const dx = px - (Transform.x[e] ?? 0);
    const dz = pz - (Transform.z[e] ?? 0);
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (!playerAlive || distance > sight) {
      aiMode[e] = AI_IDLE;
      ctx.physics.moveCharacter(e, 0, 0, 0);
      character.setState(e, AI_STATE_NAMES[AI_IDLE], 0, 0, 0, true);
      continue;
    }

    if (distance > reach) {
      aiMode[e] = AI_CHASE;
      const inverse = distance > 0 ? speed / distance : 0;
      const vx = dx * inverse;
      const vz = dz * inverse;
      ctx.physics.moveCharacter(e, vx, 0, vz);
      // Walk forwards, not sideways. The animator picks the clip from the same
      // velocity, so the two cannot disagree.
      face(e, Math.atan2(vx, vz));
      character.setState(e, AI_STATE_NAMES[AI_CHASE], vx, 0, vz, true);
      continue;
    }

    aiMode[e] = AI_ATTACK;
    ctx.physics.moveCharacter(e, 0, 0, 0);
    // Standing still, but still looking at you.
    face(e, Math.atan2(dx, dz));
    character.setState(e, AI_STATE_NAMES[AI_ATTACK], 0, 0, 0, true);
    if (aiCooldown[e] > 0) continue;
    // Only swing at something roughly at your own height, so an enemy on the
    // ramp does not punch through the floor.
    const dy = (Transform.y[player] ?? 0) + PLAYER_CENTRE - ((Transform.y[e] ?? 0) + ENEMY_CENTRE);
    if (Math.abs(dy) > 2) continue;
    aiCooldown[e] = interval;
    Health.current[player] = Math.max(0, (Health.current[player] ?? 0) - damage);
    ctx.audio.play('sfx.hit', { entity: player, volume: 0.5 });
  }
}
