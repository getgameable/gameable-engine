/**
 * The HUD: health, ammo, enemies left, a crosshair and the end-of-round line.
 *
 * `hud.set` compares the model against the previous one **one level deep**,
 * with `Object.is`. A nested object mutated in place therefore looks
 * unchanged and would never be sent. So this system keeps a flat mirror of the
 * four values it draws, compares that, and only builds the nested model on the
 * frames something actually moved — a handful of small objects a second rather
 * than four an frame.
 */
import { Enemy, Health, query, type GameContext } from 'gameable';

import { weaponState } from './systems/weapon';

/** Query terms, hoisted. */
const ENEMIES = [Enemy, Health];

/**
 * Last drawn values, so an unchanged frame costs four comparisons.
 *
 * `message: null` means "never drawn", which `''` cannot, because an empty
 * message is the normal state while the round is still going.
 */
const mirror: { health: number; ammo: number; enemies: number; message: string | null } = {
  health: -1,
  ammo: -1,
  enemies: -1,
  message: null,
};

/**
 * A rule read as a string, with a fallback.
 *
 * `ctx.rules` is whatever `defineGame` was handed, so the type is `unknown`
 * and a game that puts an object there gets its fallback rather than
 * `[object Object]` across the wire.
 *
 * @param value The rule value.
 * @param fallback What to use when the rule is missing or not a string.
 * @returns The line to draw.
 */
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Forget the last drawn values. Call from `defineGame({ init })`.
 *
 * @returns Nothing.
 */
export function resetHud(): void {
  mirror.health = -1;
  mirror.ammo = -1;
  mirror.enemies = -1;
  mirror.message = null;
}

/**
 * How many enemies are still standing.
 *
 * @param ctx The frame context.
 * @returns The count.
 */
export function enemiesLeft(ctx: GameContext): number {
  const entities = query(ctx.world, ENEMIES);
  let alive = 0;
  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i] ?? 0;
    if (e !== 0 && (Health.current[e] ?? 0) > 0) alive += 1;
  }
  return alive;
}

/**
 * Refresh the HUD when something changed.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function updateHud(ctx: GameContext): void {
  const player = ctx.player;
  const health = Math.max(0, Math.round(Health.current[player] ?? 0));
  const maximum = Math.round(Health.max[player] ?? 100);
  const ammo = weaponState.reloading > 0 ? -1 : weaponState.ammo;
  const enemies = enemiesLeft(ctx);

  const message =
    health <= 0
      ? text(ctx.rules.loseMessage, 'YOU DIED')
      : enemies === 0
        ? text(ctx.rules.winMessage, 'ARENA CLEARED')
        : '';

  if (
    health === mirror.health &&
    ammo === mirror.ammo &&
    enemies === mirror.enemies &&
    message === mirror.message
  ) {
    return;
  }
  mirror.health = health;
  mirror.ammo = ammo;
  mirror.enemies = enemies;
  mirror.message = message;

  ctx.hud.set({
    text: {
      ammo: ammo < 0 ? 'reloading' : String(ammo),
      enemies: String(enemies),
    },
    bars: { health: { value: health, max: maximum } },
    crosshair: health > 0,
    message,
  });
}
