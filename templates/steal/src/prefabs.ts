/**
 * What the things in this game are made of: thieves, the bases, the conveyor
 * and the brainrots that ride it. A prefab is a pure declaration, safe at
 * module scope; `ctx.spawn(Prefab, position)` turns one into an entity.
 *
 * A prop is a box the size of its own physics shape, so changing `dims`
 * changes what you see as well as what you hit. The base pads, the belt and
 * the brainrots collide with nothing: walking into a brainrot or onto a base
 * is a distance check on the authority, not a contact.
 */
import { activeRuntime, Player, prefab } from 'gameable';

/**
 * Entity ceiling. Must match `world.maxEntities` in `src/game.ts`, because
 * the lanes in `src/heist.ts` are sized from it.
 */
export const MAX_ENTITIES = 256;

/** Capsule radius of a thief, metres. */
export const BODY_RADIUS = 0.35;
/** Half-height of a thief's capsule section, metres. */
export const THIEF_HALF_HEIGHT = 0.8;
/** Height of a thief's centre above their feet: a capsule's origin is its centre. */
export const THIEF_CENTRE = BODY_RADIUS + THIEF_HALF_HEIGHT;

/** A base pad's half extents, metres: a flat square on the floor. */
export const PAD_HALF: readonly [number, number, number] = [1.6, 0.02, 1.6];
/** The conveyor's half extents, metres: a long strip through the middle. */
export const BELT_HALF: readonly [number, number, number] = [5, 0.05, 0.6];
/** A brainrot's half extents, metres. */
export const BRAINROT_HALF: readonly [number, number, number] = [0.3, 0.3, 0.3];

/** Collides with nothing: a marker the authority measures distances to. */
const GHOST = { layer: { trigger: true }, mask: {}, flags: { sensor: true } } as const;

/** Every player. */
export const Thief = prefab({
  name: 'thief',
  character: 'char.thief',
  body: {
    shape: 'capsule',
    dims: [BODY_RADIUS, THIEF_HALF_HEIGHT],
    kind: 'character',
    mass: 75,
    layer: { player: true },
    mask: { defaultLayer: true, staticGeometry: true, player: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  components: [Player],
});

/** One seat's base, on the ring. Stand in someone else's for `stealSeconds` to steal. */
export const Pad = prefab({
  name: 'base',
  body: { shape: 'box', dims: [...PAD_HALF], kind: 'fixed', ...GHOST },
});

/** The conveyor the brainrots ride. */
export const Belt = prefab({
  name: 'belt',
  body: { shape: 'box', dims: [...BELT_HALF], kind: 'fixed', ...GHOST },
});

/** A collectible on the conveyor. Moved with `physics.teleport`, grabbed by walking into it. */
export const Brainrot = prefab({
  name: 'brainrot',
  body: { shape: 'box', dims: [...BRAINROT_HALF], kind: 'kinematic', ...GHOST },
});

/** Pad grey, belt dark, brainrot pink. */
export const COLOURS = {
  pad: [0.36, 0.38, 0.44],
  belt: [0.16, 0.17, 0.2],
  brainrot: [1, 0.48, 0.72],
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
