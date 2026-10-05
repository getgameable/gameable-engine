/**
 * What the things in this game are made of: survivors, creatures, trees and
 * walls. A prefab is a pure declaration, safe at module scope;
 * `ctx.spawn(Prefab, position)` turns one into an entity.
 *
 * A prop is a box the size of its own physics shape, so changing `dims`
 * changes what you see as well as what you hit. A prefab with a `character`
 * wears the sample rig instead, standing on the same body's feet.
 */
import { activeRuntime, Enemy, Player, prefab } from 'gameable';

/**
 * Entity ceiling. Must match `world.maxEntities` in `src/game.ts`, because
 * the per-entity lanes in `src/camp.ts` are sized from it.
 */
export const MAX_ENTITIES = 256;

/** Capsule radius of a survivor or a creature, metres. */
export const BODY_RADIUS = 0.35;
/** Half-height of a survivor's capsule section, metres. */
export const SURVIVOR_HALF_HEIGHT = 0.8;
/** Height of a survivor's centre above its feet: a capsule's origin is its centre. */
export const SURVIVOR_CENTRE = BODY_RADIUS + SURVIVOR_HALF_HEIGHT;
/** Half-height of a creature's capsule section, metres. */
export const CREATURE_HALF_HEIGHT = 0.7;
/** Height of a creature's centre above its feet. */
export const CREATURE_CENTRE = BODY_RADIUS + CREATURE_HALF_HEIGHT;

/** Tree trunk half extents, metres. */
export const TREE_HALF: readonly [number, number, number] = [0.3, 1.6, 0.3];
/** Wall half extents, metres: two metres wide, waist high. */
export const WALL_HALF: readonly [number, number, number] = [1, 0.7, 0.15];

/** Tag: a tree. `gather` beside one gives wood. */
export const Choppable: Record<string, never> = {};
/** Tag: a wall a survivor built. Creatures go for it like a body. */
export const Barricade: Record<string, never> = {};

/** Every player. Downed at 0 health, up again at dawn. */
export const Survivor = prefab({
  name: 'survivor',
  character: 'char.survivor',
  body: {
    shape: 'capsule',
    dims: [BODY_RADIUS, SURVIVOR_HALF_HEIGHT],
    kind: 'character',
    mass: 75,
    layer: { player: true },
    mask: { defaultLayer: true, staticGeometry: true, player: true, enemy: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  health: 100,
  components: [Player],
});

/** Something from the woods. Spawned at the tree line at dusk, gone at dawn. */
export const Creature = prefab({
  name: 'creature',
  character: 'char.creature',
  body: {
    shape: 'capsule',
    dims: [BODY_RADIUS, CREATURE_HALF_HEIGHT],
    kind: 'character',
    mass: 70,
    layer: { enemy: true },
    mask: { defaultLayer: true, staticGeometry: true, player: true, enemy: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  health: 40,
  components: [Enemy],
});

/** A tree on the edge of the clearing. */
export const Tree = prefab({
  name: 'tree',
  body: {
    shape: 'box',
    dims: [...TREE_HALF],
    kind: 'fixed',
    layer: { defaultLayer: true },
    mask: { player: true, enemy: true },
  },
  components: [Choppable],
});

/** A wall, placed by `build`. Creatures hit it until it breaks. */
export const Wall = prefab({
  name: 'wall',
  body: {
    shape: 'box',
    dims: [...WALL_HALF],
    kind: 'fixed',
    layer: { defaultLayer: true },
    mask: { player: true, enemy: true },
  },
  health: 60,
  components: [Barricade],
});

/** Creature red, tree green, wall brown. */
export const COLOURS = {
  creature: [0.78, 0.16, 0.2],
  tree: [0.2, 0.55, 0.25],
  wall: [0.55, 0.38, 0.2],
} as const;

/**
 * Paint an entity, once, right after its spawn. Never per frame.
 *
 * @param entity The entity.
 * @param rgb Red, green and blue, 0..1.
 */
export function tint(entity: number, rgb: readonly [number, number, number]): void {
  activeRuntime().commands.setMaterialParam(entity, 'color', {
    tag: 'color',
    val: { r: rgb[0], g: rgb[1], b: rgb[2], a: 1 },
  });
}
