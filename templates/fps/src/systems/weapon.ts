/**
 * The weapon: a hitscan rifle on the left mouse button.
 *
 * One ray per shot, a fire-rate cooldown, a magazine and a reload. Everything
 * it needs is hoisted to module scope, because this runs sixty times a second
 * and a `{ x, y, z }` literal inside the loop is a frame spike later.
 */
import { Health, MOUSE_BUTTONS, Transform, type CollisionLayers, type GameContext } from 'gameable';

import { EYE_OFFSET } from '../prefabs';

/** Mutable weapon state. `resetWeapon` puts it back, because `init` must. */
export const weaponState = {
  /** Rounds in the magazine. */
  ammo: 0,
  /** Seconds until the next shot is allowed. */
  cooldown: 0,
  /** Seconds left of a reload, or 0. */
  reloading: 0,
  /** Shots that have landed, for the HUD and for the tests. */
  hits: 0,
};

/** Reused ray origin. A system must not allocate. */
const eye = { x: 0, y: 0, z: 0 };

/** Reused ray direction. */
const forward = { x: 0, y: 0, z: -1 };

/**
 * What the shot may hit.
 *
 * The player's own capsule is on the `player` layer and is deliberately not in
 * this set, which is cheaper and more reliable than asking the host to ignore
 * the shooter after the fact.
 */
const HIT_LAYERS: CollisionLayers = Object.freeze({ enemy: true, staticGeometry: true });

/**
 * Put the weapon back to its starting state. Call from `defineGame({ init })`.
 *
 * Module-level state survives a `restore` and, in a wasm build, is frozen into
 * the component by Wizer; resetting it in `init` is what makes two runs of the
 * same seed identical.
 *
 * @param ctx The frame context, for `ctx.rules`.
 * @returns Nothing.
 */
export function resetWeapon(ctx: GameContext): void {
  weaponState.ammo = Number(ctx.rules.magazine ?? 12);
  weaponState.cooldown = 0;
  weaponState.reloading = 0;
  weaponState.hits = 0;
}

/**
 * Aim, fire, reload.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
export function weapon(ctx: GameContext): void {
  const player = ctx.player;
  if (player === 0 || (Health.current[player] ?? 0) <= 0) return;

  const magazine = Number(ctx.rules.magazine ?? 12);
  const damage = Number(ctx.rules.damage ?? 20);
  const range = Number(ctx.rules.range ?? 60);
  const fireInterval = Number(ctx.rules.fireInterval ?? 0.18);
  const reloadTime = Number(ctx.rules.reloadTime ?? 1.1);

  if (weaponState.cooldown > 0) weaponState.cooldown -= ctx.dt;
  if (weaponState.reloading > 0) {
    weaponState.reloading -= ctx.dt;
    if (weaponState.reloading <= 0) weaponState.ammo = magazine;
    return;
  }

  const wantsReload =
    ctx.input.pressed('R') ||
    (weaponState.ammo === 0 && ctx.input.mousePressed(MOUSE_BUTTONS.LEFT));
  if (wantsReload && weaponState.ammo < magazine) {
    weaponState.reloading = reloadTime;
    return;
  }

  if (!ctx.input.mouseDown(MOUSE_BUTTONS.LEFT)) return;
  if (weaponState.cooldown > 0 || weaponState.ammo <= 0) return;

  weaponState.ammo -= 1;
  weaponState.cooldown = fireInterval;
  ctx.audio.play('sfx.shot', { entity: player, volume: 0.7 });

  // The eye, and the direction it is looking, from the built-in look
  // accumulator the SDK integrates from the mouse.
  const yaw = ctx.camera.look.yaw;
  const pitch = ctx.camera.look.pitch;
  const cosPitch = Math.cos(pitch);
  eye.x = Transform.x[player] ?? 0;
  eye.y = (Transform.y[player] ?? 0) + EYE_OFFSET;
  eye.z = Transform.z[player] ?? 0;
  forward.x = -Math.sin(yaw) * cosPitch;
  forward.y = Math.sin(pitch);
  forward.z = -Math.cos(yaw) * cosPitch;

  const hit = ctx.physics.raycast(eye, forward, range, HIT_LAYERS, player);
  if (!hit) return;
  const target = hit.entity;
  if (target === 0 || (Health.max[target] ?? 0) <= 0) return;

  Health.current[target] = (Health.current[target] ?? 0) - damage;
  weaponState.hits += 1;
  ctx.audio.play('sfx.hit', { entity: target, volume: 0.8 });
}
