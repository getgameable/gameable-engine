/**
 * The game.
 *
 * **This is the file to edit.** Everything else in `src/` is scenery: the
 * prefabs say what things are made of, the systems say what they do, and this
 * file says which of them exist, where, and with what numbers.
 *
 * The declarative fields (`assets`, `world`, `player`) are sugar over built-in
 * systems, so two games that declare the same thing behave identically.
 * `rules` is handed straight back as `ctx.rules`, which is where every tuning
 * number in this template comes from — change one there and nothing else has
 * to know.
 *
 * The whole file runs **inside the wasm guest**. It may not touch the DOM,
 * fetch anything, or ask for the time; the only way out is a command in
 * `frame-output`, and the facades on `ctx` build those for you.
 */
import { defineGame, Health, type GameContext } from 'gameable';

import { arenaSpawns } from './arena';
import { resetHud, updateHud } from './hud';
import {
  EnemyPrefab,
  ENEMY_CENTRE,
  ENEMY_COLOUR,
  EYE_OFFSET,
  MedkitPrefab,
  MEDKIT_COLOUR,
  PlayerPrefab,
  PLAYER_CENTRE,
  tint,
} from './prefabs';
import { enemyAI, resetEnemyAI } from './systems/enemyAI';
import { pickups, resetPickups } from './systems/pickups';
import { resetWeapon, weapon } from './systems/weapon';

/** Where the player starts, lifted so the capsule's feet are on the floor. */
const PLAYER_SPAWN: readonly number[] = [
  arenaSpawns.player.position[0],
  arenaSpawns.player.position[1] + PLAYER_CENTRE,
  arenaSpawns.player.position[2],
];

/** Reused spawn vector: `init` runs once, but the rule is the rule. */
const at = { x: 0, y: 0, z: 0 };

/**
 * Walk the player, in the direction the camera is facing.
 *
 * `moveCharacter` is a request, not a teleport: the host character controller
 * resolves it against the world and the result comes back next frame in
 * `Transform`.
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
function movePlayer(ctx: GameContext): void {
  const player = ctx.player;
  if (player === 0) return;
  if ((Health.current[player] ?? 0) <= 0) {
    ctx.physics.moveCharacter(player, 0, 0, 0);
    return;
  }

  const speed = Number(ctx.rules.walkSpeed ?? 5);
  const move = ctx.input.axis2('A', 'D', 'S', 'W');
  const yaw = ctx.camera.look.yaw;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // Forward is -Z, so a yaw of 0 turns (0, 1) into (0, -speed).
  const vx = (move.x * cos - move.y * sin) * speed;
  const vz = (-move.x * sin - move.y * cos) * speed;
  ctx.physics.moveCharacter(player, vx, 0, vz, ctx.input.pressed('Space'));
}

export default defineGame({
  // Optional engine features this game opts into; the page resolves each by name.
  features: { characters: true },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.enemy', 'sfx.shot', 'sfx.hit', 'sfx.pickup', 'sfx.step'],

  world: { gravity: -9.81, maxEntities: 512 },

  player: {
    prefab: PlayerPrefab,
    spawn: PLAYER_SPAWN,
    camera: 'firstPerson',
    eyeHeight: EYE_OFFSET,
    sensitivity: 0.0022,
  },

  // Every number the systems read. This is the tuning surface.
  rules: {
    walkSpeed: 5,
    magazine: 12,
    damage: 20,
    range: 60,
    fireInterval: 0.18,
    reloadTime: 1.1,
    // Sight is deliberately shorter than the arena is wide: waking all six at
    // once is a swarm, not a fight. Raise it if you want a harder opening.
    enemySpeed: 2.2,
    enemySight: 14,
    enemyReach: 1.5,
    enemyDamage: 6,
    enemyAttackInterval: 1.4,
    medkitHeal: 35,
    pickupRadius: 1.2,
    winMessage: 'ARENA CLEARED',
    loseMessage: 'YOU DIED',
  },

  init: (ctx) => {
    resetWeapon(ctx);
    resetEnemyAI();
    resetPickups();
    resetHud();

    for (const spawn of arenaSpawns.enemies) {
      at.x = spawn.position[0];
      at.y = spawn.position[1] + ENEMY_CENTRE;
      at.z = spawn.position[2];
      tint(ctx.spawn(EnemyPrefab, at), ENEMY_COLOUR[0], ENEMY_COLOUR[1], ENEMY_COLOUR[2]);
    }

    for (const spawn of arenaSpawns.pickups) {
      at.x = spawn.position[0];
      at.y = spawn.position[1];
      at.z = spawn.position[2];
      tint(ctx.spawn(MedkitPrefab, at), MEDKIT_COLOUR[0], MEDKIT_COLOUR[1], MEDKIT_COLOUR[2]);
    }

    // The host grabs pointer lock on the first click; asking here makes the
    // very first frame consistent between the browser and the test harness.
    ctx.hud.invalidate();
    console.log(`arena ready: ${String(arenaSpawns.enemies.length)} enemies`);
  },

  // Run in order, once per fixed step, after the built-ins.
  systems: [movePlayer, weapon, enemyAI, pickups, updateHud],
});
