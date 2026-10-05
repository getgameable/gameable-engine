/**
 * The game.
 *
 * **This is the file to edit.** Everything else in `src/` is scenery: the
 * prefabs say what things are made of, the systems say what they do, and this
 * file says which of them exist, where, and with what numbers.
 *
 * The declarative fields (`assets`, `world`, `player`, `spawns`) are sugar over
 * built-in systems, so two games that declare the same thing behave
 * identically. `rules` is handed straight back as `ctx.rules`, which is where
 * every tuning number in this template comes from — change one there and
 * nothing else has to know.
 *
 * The whole file runs **inside the wasm guest**. It may not touch the DOM,
 * fetch anything, or ask for the time; the only way out is a command in
 * `frame-output`, and the facades on `ctx` build those for you.
 */
import { defineGame, query, type GameContext, type PrefabDef, type SpawnSpec } from 'gameable';

import { arenaSpawns, type SpawnPoint } from './arena';
import { resetHud, updateHud } from './hud';
import {
  CHEST_CENTRE,
  CHEST_COLOUR,
  Chest,
  ChestPrefab,
  DOOR_CENTRE,
  DOOR_COLOUR,
  Door,
  DoorPrefab,
  GuidePrefab,
  HERO_CENTRE,
  HERO_COLOUR,
  HeroPrefab,
  KeyChestPrefab,
  MAX_ENTITIES,
  NPC_CENTRE,
  NPC_COLOUR,
  Npc,
  WandererPrefab,
  resetInteractables,
  tint,
} from './prefabs';
import { PHYSICS_OPTIONS } from './physicsOptions';
import { dialogueSystem, resetDialogue } from './systems/dialogue';
import { classifyInteractables, interactSystem, resetInteract } from './systems/interact';
import { locomotionSystem, resetLocomotion } from './systems/locomotion';
import { paintPlayers, resetPaint } from './systems/paintPlayers';

// A room server loads this module for the definition; it finds the page's
// physics options here too, so the two never keep separate copies.
export { PHYSICS_OPTIONS } from './physicsOptions';

/** Where the hero starts, lifted so the capsule's feet are on the floor. */
const HERO_SPAWN: readonly number[] = [
  arenaSpawns.hero.position[0],
  arenaSpawns.hero.position[1] + HERO_CENTRE,
  arenaSpawns.hero.position[2],
];

/**
 * One entry of the declarative `spawns` list: on its own feet, facing its
 * spawn yaw. A capsule had no front; a person does.
 *
 * @param prefab The prefab to place.
 * @param spawn A point from `src/arena.ts`.
 * @param centre Height of the body's centre above its feet, metres.
 * @returns The spawn entry.
 */
function place(prefab: PrefabDef, spawn: SpawnPoint, centre: number): SpawnSpec {
  const half = spawn.yaw * 0.5;
  return {
    prefab,
    position: [spawn.position[0], spawn.position[1] + centre, spawn.position[2]],
    rotation: [0, Math.sin(half), 0, Math.cos(half)],
  };
}

/**
 * Paint the level, once, the frame it exists.
 *
 * The people wear the sample character; the props are boxes the size of their
 * own physics bodies, so a coat of paint is the difference between "an
 * adventure" and "four grey lozenges".
 *
 * @param ctx The frame context.
 * @returns Nothing.
 */
function paintTheLevel(ctx: GameContext): void {
  // Alone there is one hero; in a room `paintPlayers` paints each as they join.
  if (ctx.player !== 0) tint(ctx.player, HERO_COLOUR);
  for (const e of query(ctx.world, [Npc])) tint(e, NPC_COLOUR);
  for (const e of query(ctx.world, [Chest])) tint(e, CHEST_COLOUR);
  for (const e of query(ctx.world, [Door])) tint(e, DOOR_COLOUR);
}

export default defineGame({
  // Optional engine features this game opts into; the page resolves each by name.
  // Add `multiplayer: { maxPlayers: 6 }` to play in rooms with friends: every
  // player explores, opens chests and talks for themselves
  // (docs/recipes/play-with-friends.md).
  features: { characters: true },
  // Manifest ids, resolved once during init. Never a path, never a URL.
  assets: ['env.arena', 'char.hero', 'char.guide', 'sfx.key', 'sfx.door', 'sfx.talk', 'sfx.step'],

  // The same gravity the page's physics world gets (see `src/physicsOptions.ts`).
  world: { gravity: PHYSICS_OPTIONS.gravity[1], maxEntities: MAX_ENTITIES },

  player: {
    prefab: HeroPrefab,
    spawn: HERO_SPAWN,
    camera: 'thirdPerson',
    // The boom, restated by `src/systems/locomotion.ts` every frame so the
    // orbit it computes and the rig the engine drives cannot drift apart.
    distance: 4.5,
    height: 0.4,
    sensitivity: 0.0024,
  },

  // The level. Five props, all of them declarative, because every prefab says
  // what it is with tags — nothing has to be patched up after the spawn.
  spawns: [
    place(GuidePrefab, arenaSpawns.npcs[0], NPC_CENTRE),
    place(WandererPrefab, arenaSpawns.npcs[1], NPC_CENTRE),
    place(KeyChestPrefab, arenaSpawns.chests[0], CHEST_CENTRE),
    place(ChestPrefab, arenaSpawns.chests[1], CHEST_CENTRE),
    place(DoorPrefab, arenaSpawns.door, DOOR_CENTRE),
  ],

  // Every number the systems read. This is the tuning surface.
  rules: {
    // Near the speeds the rig's clips were baked at, so the feet do not skate.
    walkSpeed: 1.6,
    runSpeed: 4,
    jumpLockFrames: 10,
    cameraDistance: 4.5,
    cameraHeight: 0.4,
    cameraPitch: -0.22,
    cameraMinPitch: -1.15,
    cameraMaxPitch: 0.6,
    interactRange: 2,
    // Cosine of the half-angle of the "in front of me" cone: 0.3 is about 72
    // degrees either side, which is generous enough not to feel fiddly.
    interactFacing: 0.3,
    messageSeconds: 2.5,
    doorTravel: 2.4,
    doorSpeed: 1.6,
    winMessage: 'You escaped',
  },

  init: (ctx) => {
    resetInteractables();
    resetInteract();
    resetDialogue();
    resetLocomotion(ctx);
    resetHud();
    resetPaint();

    classifyInteractables(ctx);
    paintTheLevel(ctx);

    ctx.hud.invalidate();
    console.log(`adventure ready: ${String(arenaSpawns.npcs.length)} people to talk to`);
  },

  // Run in order, once per fixed step, after the built-ins. Locomotion decides
  // where the hero and the camera are, interact decides what `E` would do, and
  // dialogue runs whatever conversation interact started. With multiplayer on
  // they run on the room's authority, once per player, each from that player's
  // keys; a shared chest or door stays shared, a conversation is one player's.
  systems: [paintPlayers, locomotionSystem, interactSystem, dialogueSystem, updateHud],
});
