/**
 * Brawl: two to four players in an arena, a punch, a dash and a ground slam.
 *
 * **This is the file to edit.** Every number the fight reads is in `rules`
 * below: damage, cooldowns, reach and knockback first.
 *
 * Each player walks with WASD and fights with J (punch), K (dash) and L
 * (ground slam). An ability is a message to the authority, which checks the
 * cooldown, the reach and the facing before anything happens, and confirms a
 * hit to the attacker and the victim. A fighter at 0 health is knocked out
 * and comes back at their spawn; the first to `kosToWin` knockouts wins the
 * round, and the next one starts a few seconds later.
 *
 * Where each system runs is part of the design:
 *
 * - `move` runs on **both** sides: the authority walks every fighter, and a
 *   player's page walks its own body on key-down (`predict: true`).
 * - `rounds`, `abilities` and `hud` run on the **authority**: it owns the
 *   bodies, the health and the round.
 * - `controls` runs on each player's **page**: keys become messages, a
 *   confirmed hit plays a sound, the camera looks down on the arena.
 *
 * The whole file runs **inside the wasm guest**: no DOM, no fetch, no clock.
 */
import { defineGame } from 'gameable';

import { fight, MAX_PLAYERS, SPAWNS } from './fight';
import { hud, resetHud } from './hud';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { Fighter } from './prefabs';
import { abilities } from './systems/abilities';
import { controls, resetControls } from './systems/controls';
import { move, resetMove } from './systems/move';
import { rounds } from './systems/round';

// A room server loads this module for the definition; it finds the page's
// physics options here too, so the two never keep separate copies.
export { PHYSICS_OPTIONS } from './physicsOptions';

export default defineGame({
  // Two to four fighters; each page moves its own on key-down.
  features: { characters: true, multiplayer: { maxPlayers: MAX_PLAYERS, predict: true } },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.fighter', 'sfx.hit'],

  // The same gravity the page's physics world gets (`src/physicsOptions.ts`).
  world: { gravity: PHYSICS_OPTIONS.gravity[1] },

  // One fighter per joining player, at their seat's spawn (`src/fight.ts`).
  player: { prefab: Fighter, spawn: SPAWNS },

  // Every number the systems read. This is the tuning surface.
  rules: {
    maxHp: 100,
    // Punch (J): damage, reach in metres, the arc in front it lands in, seconds between punches.
    punchDamage: 12,
    punchRange: 1.6,
    punchArcDegrees: 120,
    punchCooldown: 0.4,
    // Knockback, metres per second at the hit, and how fast it fades (per second).
    punchKnockback: 7,
    slamKnockback: 10,
    knockbackDecay: 6,
    // Dash (K): speed, how long, seconds between dashes.
    dashSpeed: 14,
    dashSeconds: 0.15,
    dashCooldown: 1.5,
    // Ground slam (L): damage to everyone within the radius, seconds between slams.
    slamDamage: 20,
    slamRadius: 2.5,
    slamCooldown: 3,
    // The round.
    respawnSeconds: 2,
    kosToWin: 3,
    roundOverSeconds: 4,
    flashSeconds: 0.15,
    walkSpeed: 4.5,
  },

  init: () => {
    fight.reset();
    resetHud();
    resetMove();
    resetControls();
  },

  // In order, once per fixed step, after the built-ins. The messages are in `src/messages.ts`.
  systems: [
    { run: rounds, on: 'authority' }, // seats, respawns, the round and the room's phase
    { run: abilities, on: 'authority' }, // punch, dash and slam, checked here
    { run: move, on: 'both' }, // every fighter here; the page's own body there
    { run: hud, on: 'authority' },
    { run: controls, on: 'client' }, // J, K and L become messages; a hit plays a sound
  ],
});
