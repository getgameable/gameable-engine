/**
 * Medkits: walk into one and it heals you.
 *
 * A distance check rather than `physics.overlapSphere`, because an overlap
 * query is a synchronous round trip across the wasm boundary and three
 * pickups do not justify one every frame. Both entities' transforms are
 * already in the guest, so the test is free.
 */
import { Health, Pickup, query, Transform, type GameContext } from 'gameable';

/** Query terms, hoisted. */
const PICKUPS = [Pickup, Transform];

/** Collected this run, for the HUD and the tests. */
export const pickupState = { collected: 0 };

/**
 * Forget what has been collected. Call from `defineGame({ init })`.
 *
 * @returns Nothing.
 */
export function resetPickups(): void {
  pickupState.collected = 0;
}

/**
 * Heal the player when it touches a medkit.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function pickups(ctx: GameContext): void {
  const player = ctx.player;
  if (player === 0) return;

  const current = Health.current[player] ?? 0;
  if (current <= 0) return;
  const maximum = Health.max[player] ?? 100;
  if (current >= maximum) return;

  const heal = Number(ctx.rules.medkitHeal ?? 35);
  const radius = Number(ctx.rules.pickupRadius ?? 1.2);
  const radiusSquared = radius * radius;

  const px = Transform.x[player] ?? 0;
  const py = Transform.y[player] ?? 0;
  const pz = Transform.z[player] ?? 0;

  const entities = query(ctx.world, PICKUPS);
  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i] ?? 0;
    if (e === 0) continue;
    const dx = px - (Transform.x[e] ?? 0);
    const dy = py - (Transform.y[e] ?? 0);
    const dz = pz - (Transform.z[e] ?? 0);
    if (dx * dx + dy * dy + dz * dz > radiusSquared) continue;

    Health.current[player] = Math.min(maximum, current + heal);
    pickupState.collected += 1;
    ctx.audio.play('sfx.pickup', { entity: player, volume: 0.9 });
    ctx.despawn(e);
    return;
  }
}
