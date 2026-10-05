/**
 * Survive: four to six players hold a camp in a clearing, night after night.
 *
 * **This is the file to edit.** By day, everyone walks to the trees and
 * presses E for wood, then B to put a wall up in front of them. At dusk the
 * creatures come out of the tree line, more each night, and walk at the
 * nearest camp body: a survivor on their feet, or a wall. They hit what they
 * reach; a survivor at 0 health is down until dawn, a wall at 0 falls. At
 * dawn the creatures are gone, every survivor still standing counts one more
 * night survived (`nightsSurvived`), and the downed get up at the camp.
 *
 * Where each system runs is part of the design:
 *
 * - `seats`, `clock`, `move`, `work`, `creatures` and `hud` run on the
 *   **authority**: it owns the bodies, the wood and the night.
 * - `controls` runs on each player's **client**: keys become messages, and
 *   what happens to this player plays a sound on this page only.
 *
 * The whole file runs **inside the wasm guest**: no DOM, no fetch, no clock.
 */
import { defineGame, query, type GameContext } from 'gameable';

import { CAMP, TREES } from './arena';
import { camp, MAX_PLAYERS } from './camp';
import { hud, resetHud } from './hud';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { Choppable, COLOURS, MAX_ENTITIES, Survivor, tint } from './prefabs';
import { clock } from './systems/clock';
import { controls } from './systems/controls';
import { creatures } from './systems/creatures';
import { move, resetMove } from './systems/move';
import { seats } from './systems/seats';
import { work } from './systems/work';

// A room server loads this module for the definition; it finds the page's
// physics options here too, so the two never keep separate copies.
export { PHYSICS_OPTIONS } from './physicsOptions';

/**
 * Paint the trees, once, at `init`.
 *
 * @param ctx The init context.
 */
function paintTrees(ctx: GameContext): void {
  for (const tree of query(ctx.world, [Choppable])) tint(tree, COLOURS.tree);
}

export default defineGame({
  // The page loads the character stack; a room seats up to six.
  features: { characters: true, multiplayer: { maxPlayers: MAX_PLAYERS } },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.survivor', 'char.creature', 'sfx.chop', 'sfx.hit'],

  // The same gravity the page's physics world gets (see `src/physicsOptions.ts`).
  world: { gravity: PHYSICS_OPTIONS.gravity[1], maxEntities: MAX_ENTITIES },

  // Spawned once per joining player on the authority, at the camp.
  player: {
    prefab: Survivor,
    spawn: CAMP,
    camera: 'thirdPerson',
    distance: 4.5,
    height: 0.4,
    sensitivity: 0.0024,
  },

  // The clearing's trees (`src/arena.ts`).
  spawns: TREES,

  // Every number the systems read. This is the tuning surface.
  rules: {
    // The clock, in seconds.
    daySeconds: 60,
    nightSeconds: 45,
    // Creatures on the first night, and how many more each night after.
    creaturesFirstNight: 3,
    creaturesPerNight: 1,
    creatureSpeed: 2,
    creatureReach: 1.4,
    creatureDamage: 10,
    creatureHitSeconds: 1,
    // Wood: how close to a tree E works, what one press gives, what a wall costs.
    gatherRange: 1.8,
    woodPerGather: 1,
    wallCost: 2,
    // How far in front of the builder a wall goes up, metres.
    buildDistance: 1.5,
    walkSpeed: 1.6,
    runSpeed: 4,
    cameraDistance: 4.5,
    cameraHeight: 0.4,
  },

  init: (ctx) => {
    camp.reset();
    resetHud();
    resetMove(ctx);
    paintTrees(ctx);
    console.log(`survive ready: up to ${String(MAX_PLAYERS)} players`);
  },

  // In order, once per fixed step, after the built-ins. The messages they
  // read (`gather`, `build`) are declared in `src/messages.ts`.
  systems: [
    { run: seats, on: 'authority' }, // a seat left or taken starts again
    { run: clock, on: 'authority' }, // dusk spawns creatures, dawn counts the night
    { run: move, on: 'authority' },
    { run: work, on: 'authority' }, // gather and build
    { run: creatures, on: 'authority' }, // walk at the nearest camp body, hit it
    { run: hud, on: 'authority' },
    { run: controls, on: 'client' }, // E and B become messages
  ],
});
