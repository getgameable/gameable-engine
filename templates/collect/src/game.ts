/**
 * Collect: a pet simulator for up to eight players.
 *
 * **This is the file to edit.** Walk over coins for bucks. Press B to buy an
 * egg; it hatches after `hatchSeconds` into a pet whose kind is drawn on the
 * authority (`src/pets.ts` has the odds). Your three newest pets follow you.
 * C combines four identical pets into one of the next tier. Stand near
 * someone and press T to offer them a swap of your newest pets; they press Y
 * to accept, and the trade happens all at once or not at all.
 *
 * Everything you own is your player document, `{ bucks, pets, eggs }`, kept
 * by the room's store: leave, come back tomorrow, it is still yours.
 *
 * Where each system runs is part of the design:
 *
 * - `seats`, `move`, `coins`, `shop`, `trade`, `follow`, `deals` and `hud`
 *   run on the **authority**: it owns the documents, the coins and the dice.
 * - `controls` runs on each player's **client**: keys become messages.
 *
 * The whole file runs **inside the wasm guest**: no DOM, no fetch, no clock.
 */
import { defineGame } from 'gameable';

import { SPAWN } from './arena';
import { collection, MAX_PLAYERS } from './collection';
import { hud, resetHud } from './hud';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { Collector, MAX_ENTITIES } from './prefabs';
import { coins } from './systems/coins';
import { controls, resetControls } from './systems/controls';
import { deals, resetDeals } from './systems/deals';
import { follow } from './systems/follow';
import { move, resetMove } from './systems/move';
import { seats } from './systems/seats';
import { shop } from './systems/shop';
import { trade } from './systems/trade';

// A room server loads this module for the definition; it finds the page's
// physics options here too, so the two never keep separate copies.
export { PHYSICS_OPTIONS } from './physicsOptions';

export default defineGame({
  // The page loads the character stack; a room seats up to eight.
  features: { characters: true, multiplayer: { maxPlayers: MAX_PLAYERS } },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.collector', 'sfx.coin', 'sfx.hatch'],

  // The same gravity the page's physics world gets (see `src/physicsOptions.ts`).
  world: { gravity: PHYSICS_OPTIONS.gravity[1], maxEntities: MAX_ENTITIES },

  // Spawned once per joining player on the authority, in the middle.
  player: {
    prefab: Collector,
    spawn: SPAWN,
    camera: 'thirdPerson',
    distance: 4.5,
    height: 0.4,
    sensitivity: 0.0024,
  },

  // Every number the systems read. This is the tuning surface.
  rules: {
    // Eggs: what one costs, how long it takes, how many you can carry.
    eggCost: 25,
    hatchSeconds: 10,
    maxEggs: 3,
    // Coins: how many lie about, what each is worth, how close picks one up.
    coinCount: 16,
    coinValue: 5,
    coinRange: 1.2,
    // A new player's bucks.
    startBucks: 0,
    // Four of a kind and tier make one of the next tier, up to this one.
    maxTier: 5,
    // Trades: how near the T deal looks, and the bucks it asks on a side with no pet.
    tradeRange: 3,
    dealBucks: 20,
    // How quickly pets catch up, per second.
    petFollow: 4,
    walkSpeed: 1.6,
    runSpeed: 4,
    cameraDistance: 4.5,
    cameraHeight: 0.4,
  },

  init: (ctx) => {
    collection.reset();
    resetHud();
    resetMove(ctx);
    resetDeals();
    resetControls();
    console.log(`collect ready: up to ${String(MAX_PLAYERS)} players`);
  },

  // In order, once per fixed step, after the built-ins. The messages they
  // read (`buy`, `combine`, `offer`, `accept`) are declared in `src/messages.ts`.
  systems: [
    { run: seats, on: 'authority' }, // documents in at join, pets and offers out at leave
    { run: (ctx) => ctx.net.setPhase('open'), on: 'authority' }, // the room list says "open"
    { run: move, on: 'authority' },
    { run: coins, on: 'authority' }, // walk over a coin for bucks
    { run: shop, on: 'authority' }, // buy, hatch, combine
    { run: trade, on: 'authority' }, // offer, accept, one exchange
    { run: follow, on: 'authority' }, // the newest three pets walk with you
    { run: deals, on: 'authority' }, // the swap T would offer
    { run: hud, on: 'authority' },
    { run: controls, on: 'client' }, // B, C, T and Y become messages
  ],
});
