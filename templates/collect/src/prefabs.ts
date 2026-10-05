/**
 * What the things in this game are made of: collectors (the players), their
 * pets and the coins on the ground. A prefab is a pure declaration, safe at
 * module scope; `ctx.spawn(Prefab, position)` turns one into an entity.
 *
 * A prop is a box the size of its own physics shape, so changing `dims`
 * changes what you see. Pets and coins are sensors: nothing bumps into them.
 */
import { activeRuntime, Player, prefab, RigidBody } from 'gameable';

/**
 * Entity ceiling. Must match `world.maxEntities` in `src/game.ts`: eight
 * players, three pets each and the coins fit with room to spare.
 */
export const MAX_ENTITIES = 256;

/** Capsule radius of a collector, metres. */
export const BODY_RADIUS = 0.35;
/** Half-height of a collector's capsule section, metres. */
export const BODY_HALF_HEIGHT = 0.8;
/** Height of a collector's centre above its feet: a capsule's origin is its centre. */
export const BODY_CENTRE = BODY_RADIUS + BODY_HALF_HEIGHT;

/** Pet half extents, metres: a knee-high cube. */
export const PET_HALF: [number, number, number] = [0.22, 0.22, 0.22];
/** Coin half extents, metres: a flat gold tile. */
export const COIN_HALF: [number, number, number] = [0.25, 0.05, 0.25];

/** Tag: a pet following its owner. */
export const Pet: Record<string, never> = {};
/** Tag: a coin. Walk over it for bucks. */
export const Coin: Record<string, never> = {};

/** Every player. */
export const Collector = prefab({
  name: 'collector',
  character: 'char.collector',
  body: {
    shape: 'capsule',
    dims: [BODY_RADIUS, BODY_HALF_HEIGHT],
    kind: 'character',
    mass: 75,
    layer: { player: true },
    mask: { defaultLayer: true, staticGeometry: true, player: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  components: [Player],
});

/** A pet: kinematic, moved by the authority behind its owner (`src/systems/follow.ts`). */
export const PetBody = prefab({
  name: 'pet',
  body: {
    shape: 'box',
    dims: PET_HALF,
    kind: 'kinematic',
    layer: { trigger: true },
    mask: { trigger: true },
    flags: { sensor: true },
  },
  components: [Pet],
});

/** A coin: kinematic, so a pick-up can move it somewhere else. */
export const CoinBody = prefab({
  name: 'coin',
  body: {
    shape: 'box',
    dims: COIN_HALF,
    kind: 'kinematic',
    layer: { trigger: true },
    mask: { trigger: true },
    flags: { sensor: true },
  },
  components: [Coin],
});

/** Coin gold. Pets take their kind's colour (`src/pets.ts`). */
export const GOLD: readonly [number, number, number] = [1, 0.82, 0.2];

/**
 * Paint an entity, once, right after its spawn or when what it shows changes.
 * Never per frame.
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

/**
 * Move a kinematic body.
 *
 * @param entity The body's entity.
 * @param x World x.
 * @param y World y.
 * @param z World z.
 * @param teleport True to jump (pages snap); false to glide (pages interpolate).
 */
export function place(entity: number, x: number, y: number, z: number, teleport: boolean): void {
  const body = RigidBody.handle[entity] ?? 0;
  if (body === 0) return;
  activeRuntime().commands.setBodyTransform(body, x, y, z, 0, 0, 0, 1, teleport);
}
