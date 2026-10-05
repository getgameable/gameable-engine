/**
 * What the things in this game are made of.
 *
 * A prefab is a pure declaration — it resolves nothing and is safe at module
 * scope. `ctx.spawn(Prefab, position)` turns one into an entity, writes the
 * built-in components, and queues the commands the host needs.
 *
 * A prop is a box the size of its own physics shape, so changing `dims`
 * changes what you see as well as what you hit. A prefab with a `character`
 * draws a real rig instead, standing on the same body's feet.
 *
 * **The tags are the vocabulary.** `Interactable` says "E does something here",
 * and one of `Chest` / `Door` / `Npc` / `Key` says what. That is why every
 * prefab below is declarative — nothing has to be patched up after the spawn,
 * so `src/game.ts` can lay the level out in a `spawns` list and the systems can
 * ask what a thing is with one array read.
 */
import { activeRuntime, Pickup, Player, prefab } from 'gameable';

/**
 * Entity ceiling. Must match `world.maxEntities` in `src/game.ts`, because the
 * per-entity lanes below are sized from it.
 */
export const MAX_ENTITIES = 256;

/** Hero capsule radius, metres. */
export const HERO_RADIUS = 0.35;
/** Half-height of the hero capsule's cylindrical section, metres. */
export const HERO_HALF_HEIGHT = 0.8;
/**
 * Height of the hero capsule's centre above its feet.
 *
 * A Jolt capsule's origin is its centre, so a spawn point on the floor has to
 * be lifted by this much or the hero starts buried.
 */
export const HERO_CENTRE = HERO_RADIUS + HERO_HALF_HEIGHT;

/** NPC capsule radius, metres. */
export const NPC_RADIUS = 0.35;
/** Half-height of an NPC capsule's cylindrical section, metres. */
export const NPC_HALF_HEIGHT = 0.7;
/** Height of an NPC capsule's centre above its feet. */
export const NPC_CENTRE = NPC_RADIUS + NPC_HALF_HEIGHT;
/** Height of an NPC's eyes above its feet: what a hero looks at. */
export const NPC_EYE_HEIGHT = 1.55;

/** Chest half extents, metres. */
export const CHEST_HALF: readonly [number, number, number] = [0.42, 0.28, 0.3];
/** Height of a chest's centre above its feet. */
export const CHEST_CENTRE = CHEST_HALF[1];

/** Door half extents, metres: a slab as wide as a doorway. */
export const DOOR_HALF: readonly [number, number, number] = [1.1, 1.2, 0.18];
/** Height of the door's centre above the floor. */
export const DOOR_CENTRE = DOOR_HALF[1];

/** Key half extent, metres. */
export const KEY_HALF = 0.12;
/** How high above the floor a dropped key floats. */
export const KEY_HEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Tag: `E` does something when the hero is in front of this. */
export const Interactable: Record<string, never> = {};

/** Tag: a chest. Open it. */
export const Chest: Record<string, never> = {};

/** Tag: this chest is the one with the key in it. */
export const HoldsKey: Record<string, never> = {};

/** Tag: the door out. It only opens with the key. */
export const Door: Record<string, never> = {};

/** Tag: somebody to talk to. */
export const Npc: Record<string, never> = {};

/** Tag: this NPC runs the `guide` conversation in `src/dialogue.json`. */
export const Guide: Record<string, never> = {};

/** Tag: this NPC runs the `wanderer` conversation in `src/dialogue.json`. */
export const Wanderer: Record<string, never> = {};

/** Tag: a key lying on the floor. */
export const Key: Record<string, never> = {};

// ---------------------------------------------------------------------------
// Interaction kinds
// ---------------------------------------------------------------------------

/** Not interactable, or not yet classified. */
export const KIND_NONE = 0;
/** A chest. */
export const KIND_CHEST = 1;
/** The door. */
export const KIND_DOOR = 2;
/** An NPC. */
export const KIND_NPC = 3;
/** A key on the floor. */
export const KIND_KEY = 4;

/**
 * Which kind each interactable is, and whether it has already been used.
 *
 * Flat lanes indexed by entity id: that is what a component is in this ECS, and
 * it means the interact system reads one number per candidate rather than
 * asking bitecs three questions. `classifyInteractables` fills `kind` in from
 * the tags once, in `init`; `used` is written as the game is played.
 */
export const interactables = {
  /** One of the `KIND_*` constants. */
  kind: new Uint8Array(MAX_ENTITIES),
  /** 1 once a chest has been opened or a door has been unlocked. */
  used: new Uint8Array(MAX_ENTITIES),
};

/**
 * Forget every classification. Call from `defineGame({ init })` **before**
 * classifying, because module-level state survives a rebuild and is frozen
 * into the wasm component by Wizer.
 *
 * @returns Nothing.
 */
export function resetInteractables(): void {
  interactables.kind.fill(0);
  interactables.used.fill(0);
}

// ---------------------------------------------------------------------------
// Prefabs
// ---------------------------------------------------------------------------

/**
 * The hero: a capsule driven by the host character controller, wearing the
 * sample character.
 *
 * Unlike the FPS player it is drawn, because the camera is behind it — that is
 * the whole point of a third-person game.
 */
export const HeroPrefab = prefab({
  name: 'hero',
  character: 'char.hero',
  body: {
    shape: 'capsule',
    dims: [HERO_RADIUS, HERO_HALF_HEIGHT],
    kind: 'character',
    mass: 75,
    layer: { player: true },
    mask: {
      defaultLayer: true,
      staticGeometry: true,
      character: true,
      pickup: true,
      trigger: true,
    },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  health: 100,
  components: [Player],
});

/** Body every NPC shares: a capsule that stands where it is put. */
const NPC_BODY = {
  shape: 'capsule',
  dims: [NPC_RADIUS, NPC_HALF_HEIGHT],
  kind: 'character',
  mass: 70,
  layer: { character: true },
  mask: { defaultLayer: true, staticGeometry: true, player: true, character: true },
  flags: { reportContacts: true, noSleep: true },
} as const;

/**
 * The guide: the NPC standing in front of where the hero starts.
 *
 * `character: 'char.guide'` is the interesting line. It makes `ctx.spawn` emit
 * a `spawn-character` naming an id in `src/assets.json`, and the host loads
 * that rig, hides the capsule and blends its clips from whatever
 * `character.setState` last said. Point the id at a different entry and this
 * file does not change.
 */
export const GuidePrefab = prefab({
  name: 'guide',
  body: NPC_BODY,
  character: 'char.guide',
  components: [Interactable, Npc, Guide],
});

/** The wanderer: a second NPC, with a shorter script and no branch. */
export const WandererPrefab = prefab({
  name: 'wanderer',
  body: NPC_BODY,
  character: 'char.guide',
  components: [Interactable, Npc, Wanderer],
});

/** Body both chests share: a static box you cannot walk through. */
const CHEST_BODY = {
  shape: 'box',
  dims: CHEST_HALF,
  kind: 'fixed',
  layer: { defaultLayer: true },
  mask: { player: true, character: true },
} as const;

/** The chest with the key in it. */
export const KeyChestPrefab = prefab({
  name: 'chest-key',
  body: CHEST_BODY,
  components: [Interactable, Chest, HoldsKey],
});

/** A chest with nothing in it. Adventure games are like that. */
export const ChestPrefab = prefab({
  name: 'chest',
  body: CHEST_BODY,
  components: [Interactable, Chest],
});

/**
 * The door out: a kinematic slab.
 *
 * Kinematic, not fixed, because it moves and nothing pushes it — the interact
 * system slides it sideways with `physics.teleport`, which the host turns into
 * a `set-body-transform`.
 */
export const DoorPrefab = prefab({
  name: 'door',
  body: {
    shape: 'box',
    dims: DOOR_HALF,
    kind: 'kinematic',
    layer: { defaultLayer: true },
    mask: { player: true, character: true },
  },
  components: [Interactable, Door],
});

/** The key, once a chest has coughed it up: a small gold box on the floor. */
export const KeyPrefab = prefab({
  name: 'key',
  body: {
    shape: 'box',
    dims: [KEY_HALF, KEY_HALF, KEY_HALF],
    kind: 'fixed',
    layer: { pickup: true },
    mask: { player: true },
    flags: { sensor: true },
  },
  components: [Interactable, Key, Pickup],
});

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/**
 * Paint an entity: its placeholder mesh, or its character's materials.
 *
 * `set-material-param` is a normal frame-output command; there is no facade
 * for it on `ctx` because a real game sets a material through its asset, not
 * through a uniform. Call it right after `ctx.spawn`, once, never per frame.
 *
 * @param entity The entity to paint.
 * @param colour Linear RGB, each component 0..1.
 * @returns The entity, so this can wrap a `ctx.spawn` call.
 */
export function tint(entity: number, colour: readonly [number, number, number]): number {
  activeRuntime().commands.setMaterialParam(entity, 'color', {
    tag: 'color',
    val: { r: colour[0], g: colour[1], b: colour[2], a: 1 },
  });
  return entity;
}

/** Hero teal. */
export const HERO_COLOUR: readonly [number, number, number] = [0.24, 0.62, 0.72];
/** NPC amber. */
export const NPC_COLOUR: readonly [number, number, number] = [0.86, 0.66, 0.24];
/** Chest brown. */
export const CHEST_COLOUR: readonly [number, number, number] = [0.45, 0.3, 0.16];
/** Door slate. */
export const DOOR_COLOUR: readonly [number, number, number] = [0.3, 0.34, 0.42];
/** Key gold. */
export const KEY_COLOUR: readonly [number, number, number] = [0.92, 0.78, 0.2];
