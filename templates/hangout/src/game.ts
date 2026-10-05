/**
 * Hangout: up to twelve players on a street of six houses. No round, no
 * score, no win: a place to be with friends.
 *
 * **This is the file to edit.** Each player moves into a house (two to a
 * house, `src/street.ts`) and spawns at its door. E opens and closes the
 * nearest front door, gets into the nearest free car, and gets out again;
 * the driver steers it with WASD. F sits on a bench, 1-6 wear a colour
 * everyone sees, and Enter opens the chat line, echoed with the sender's
 * name.
 *
 * Where each system runs is part of the design:
 *
 * - every system but `controls` runs on the **authority**: it owns the
 *   bodies, the doors and the cars, and reads each player's own keys;
 * - `controls` runs on each player's **client**: F and 1-6 become messages
 *   (`src/messages.ts`).
 *
 * The whole file runs **inside the wasm guest**: no DOM, no fetch, no clock.
 */
import { defineGame, type GameContext, type PrefabDef, type SpawnSpec } from 'gameable';

import { chatLog } from './chat';
import { resetHud, streetHud } from './hud';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { FrontDoor, House, MAX_ENTITIES, ParkBench, Resident, Sedan } from './prefabs';
import { findProps } from './props';
import { MAX_PLAYERS, resetResidents } from './residents';
import {
  BENCH_HALF,
  BENCH_SPOTS,
  CAR_HALF,
  CAR_SPOTS,
  DOOR_HALF,
  HOUSE_HALF,
  LOTS,
  doorAt,
  spawnPoints,
  yawQuat,
} from './street';
import { arrive } from './systems/arrive';
import { chat } from './systems/chat';
import { controls } from './systems/controls';
import { cosmetic } from './systems/cosmetic';
import { slideDoors } from './systems/doors';
import { drive } from './systems/drive';
import { interact } from './systems/interact';
import { sit } from './systems/sit';
import { resetWalk, walk } from './systems/walk';

// A room server loads this module for the definition; it finds the page's
// physics options here too, so the two never keep separate copies.
export { PHYSICS_OPTIONS } from './physicsOptions';

/**
 * @param prefab What to spawn.
 * @param x World x.
 * @param y Height of its centre.
 * @param z World z.
 * @param yaw Radians about +Y.
 * @returns One `spawns` entry.
 */
function at(prefab: PrefabDef, x: number, y: number, z: number, yaw = 0): SpawnSpec {
  return { prefab, position: [x, y, z], rotation: yawQuat(yaw) };
}

/** The street: six houses with their doors, two cars, two benches. */
const STREET: SpawnSpec[] = [
  ...LOTS.map((lot) => at(House, lot.x, HOUSE_HALF[1], lot.z)),
  ...LOTS.map((_, house) => at(FrontDoor, doorAt(house)[0], DOOR_HALF[1], doorAt(house)[1])),
  ...CAR_SPOTS.map(([x, z]) => at(Sedan, x, CAR_HALF[1], z, Math.PI / 2)),
  ...BENCH_SPOTS.map(([x, z]) => at(ParkBench, x, BENCH_HALF[1], z)),
];

/** The room list shows this street as open, always. */
const listing = (ctx: GameContext): void => {
  ctx.net.setPhase('open');
};

export default defineGame({
  // The page loads the character stack; a room seats up to twelve.
  features: { characters: true, multiplayer: { maxPlayers: MAX_PLAYERS } },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.resident'],

  // The same gravity the page's physics world gets (see `src/physicsOptions.ts`).
  world: { gravity: PHYSICS_OPTIONS.gravity[1], maxEntities: MAX_ENTITIES },

  // Spawned once per joining player on the authority: seat n at house n % 6's door.
  player: {
    prefab: Resident,
    spawn: spawnPoints(MAX_PLAYERS),
    camera: 'thirdPerson',
    distance: 4.5,
    height: 0.4,
    sensitivity: 0.0024,
  },

  spawns: STREET,

  // Every number the systems read. This is the tuning surface.
  rules: {
    walkSpeed: 1.6,
    runSpeed: 4,
    cameraDistance: 4.5,
    cameraHeight: 0.4,
    cameraPitch: -0.22,
    cameraMinPitch: -1.15,
    cameraMaxPitch: 0.6,
    // Metres from a body's centre to a door, a car or a bench for E or F to reach it.
    doorRange: 2,
    carRange: 2.6,
    sitRange: 1.5,
    // How far a door slides open, metres, and how fast.
    doorTravel: 1.2,
    doorSpeed: 2,
    // Top speed forward and in reverse, metres per second; acceleration; turn rate at top speed.
    carSpeed: 9,
    carReverse: 3,
    carAccel: 6,
    carTurnRate: 1.6,
  },

  init: (ctx) => {
    resetResidents();
    resetHud();
    resetWalk(ctx);
    chatLog.reset();
    findProps(ctx);
    console.log(`hangout ready: ${String(LOTS.length)} houses, up to ${String(MAX_PLAYERS)}`);
  },

  // In order, once per fixed step, after the built-ins.
  systems: [
    { run: arrive, on: 'authority' }, // a new resident gets their house
    { run: chat, on: 'authority' }, // echoed to everyone with the sender's name
    { run: cosmetic, on: 'authority' }, // 1-6: the sender's colour, for everyone
    { run: interact, on: 'authority' }, // E: doors and cars
    { run: sit, on: 'authority' }, // F: a bench
    { run: walk, on: 'authority' }, // WASD for everyone not sitting or driving
    { run: drive, on: 'authority' }, // WASD for drivers; `sit` for the seated
    { run: slideDoors, on: 'authority' },
    { run: streetHud, on: 'authority' },
    { run: listing, on: 'authority' },
    { run: controls, on: 'client' }, // F and 1-6 become messages
  ],
});
