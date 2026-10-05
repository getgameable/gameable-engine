/**
 * Steal: up to six players, a base each on a ring, and a conveyor through the
 * middle that brings out a brainrot every few seconds.
 *
 * **This is the file to edit.** Walk into a brainrot on the belt to take it
 * home. Every brainrot in your base pays you coins every `incomeSeconds`.
 * Stand in someone else's base for `stealSeconds` and you take their newest
 * one. Q shields your base for a while; R, once you are rich enough, gives up
 * everything for a higher multiplier (a rebirth).
 *
 * Progress outlives the room: each player's `{ coins, owned, shieldUntil,
 * rebirths }` is their document in the room's store (`ctx.data`), loaded at
 * join, saved when it changes, and written when they leave. Coming back pays
 * for the time away, up to `offlineCapHours`.
 *
 * Where each system runs is part of the design:
 *
 * - `seats`, `move`, `belt`, `steal`, `income`, `actions` and `hud` run on the
 *   **authority**: it owns the bodies, the brainrots and every wallet.
 * - `controls` runs on each player's **client**: keys become messages, and
 *   what happens to this player plays a sound on this page only.
 *
 * The whole file runs **inside the wasm guest**: no DOM, no fetch, no clock.
 */
import { defineGame, type GameContext } from 'gameable';

import { heist } from './heist';
import { hud, resetHud } from './hud';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { Belt, COLOURS, MAX_ENTITIES, Pad, Thief, tint } from './prefabs';
import { BASES, MAX_PLAYERS, SPAWNS } from './ring';
import { actions } from './systems/actions';
import { belt } from './systems/belt';
import { controls } from './systems/controls';
import { income } from './systems/income';
import { move, resetMove } from './systems/move';
import { seats } from './systems/seats';
import { steal } from './systems/steal';

// A room server loads this module for the definition; it finds the page's
// physics options here too, so the two never keep separate copies.
export { PHYSICS_OPTIONS } from './physicsOptions';

/** Reused spawn point. */
const at = { x: 0, y: 0.02, z: 0 };

/**
 * Lay out the bases and the belt, once, at `init`.
 *
 * @param ctx The init context.
 */
function layOut(ctx: GameContext): void {
  for (const base of BASES) {
    at.x = base.x;
    at.z = base.z;
    tint(ctx.spawn(Pad, at), COLOURS.pad);
  }
  at.x = 0;
  at.z = 0;
  tint(ctx.spawn(Belt, at), COLOURS.belt);
}

export default defineGame({
  // The page loads the character stack; a room seats up to six, a base each.
  features: { characters: true, multiplayer: { maxPlayers: MAX_PLAYERS } },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.thief', 'sfx.grab', 'sfx.steal'],

  // The same gravity the page's physics world gets (see `src/physicsOptions.ts`).
  world: { gravity: PHYSICS_OPTIONS.gravity[1], maxEntities: MAX_ENTITIES },

  // Spawned once per joining player on the authority, in their own base.
  player: {
    prefab: Thief,
    spawn: SPAWNS,
    camera: 'thirdPerson',
    distance: 4.5,
    height: 0.4,
    sensitivity: 0.0024,
  },

  // Every number the systems read. This is the tuning surface.
  rules: {
    // The conveyor: a brainrot every this many seconds, riding at this speed (m/s).
    conveyorSeconds: 8,
    beltSpeed: 1.2,
    // How close counts as walking into a brainrot, metres.
    grabRadius: 0.9,
    // Seconds standing in someone else's base to take their newest brainrot.
    stealSeconds: 3,
    // Half the width of a base, metres.
    baseRadius: 1.6,
    // Income: coins per brainrot, every this many seconds.
    incomeSeconds: 10,
    incomePerItem: 1,
    // The most time away that still pays, hours.
    offlineCapHours: 8,
    // Q: a shield for this long, for this many coins.
    shieldSeconds: 20,
    shieldCost: 10,
    // R: a rebirth costs everything and needs this many coins; each one adds this to the multiplier.
    rebirthCost: 100,
    rebirthBonus: 0.5,
    walkSpeed: 1.6,
    runSpeed: 4,
    cameraDistance: 4.5,
    cameraHeight: 0.4,
  },

  init: (ctx) => {
    heist.reset();
    resetHud();
    resetMove(ctx);
    layOut(ctx);
    console.log(`steal ready: up to ${String(MAX_PLAYERS)} players`);
  },

  // In order, once per fixed step, after the built-ins. The messages they
  // read (`shield`, `rebirth`) are declared in `src/messages.ts`.
  systems: [
    { run: seats, on: 'authority' }, // a join loads the wallet and pays for the time away
    { run: move, on: 'authority' },
    { run: belt, on: 'authority' }, // spawn, ride, grab
    { run: steal, on: 'authority' }, // stand in a base, one exchange per steal
    { run: income, on: 'authority' },
    { run: actions, on: 'authority' }, // shield and rebirth
    { run: hud, on: 'authority' },
    { run: controls, on: 'client' }, // Q and R become messages
  ],
});
