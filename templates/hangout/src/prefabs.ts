/**
 * What the things on the street are made of. A prop is a box the size of its
 * own physics shape; a resident wears the sample character.
 *
 * The tags say what a thing is: `Home`, `Door`, `Car` and `Bench`. `src/props.ts`
 * finds each kind once, in `init`.
 */
import { activeRuntime, Player, prefab } from 'gameable';

import { BENCH_HALF, CAR_HALF, DOOR_HALF, HOUSE_HALF } from './street';

/** Entity ceiling. Must match `world.maxEntities` in `src/game.ts`. */
export const MAX_ENTITIES = 256;

/** Tag: a house. */
export const Home: Record<string, never> = {};
/** Tag: a house's front door. E opens and closes it. */
export const Door: Record<string, never> = {};
/** Tag: a car. E gets in (when it is free) and out. */
export const Car: Record<string, never> = {};
/** Tag: somewhere to sit. F near it sits down. */
export const Bench: Record<string, never> = {};

/** A player: a capsule the host character controller drives, wearing the sample character. */
export const Resident = prefab({
  name: 'resident',
  character: 'char.resident',
  body: {
    shape: 'capsule',
    dims: [0.35, 0.8],
    kind: 'character',
    mass: 75,
    layer: { player: true },
    mask: { defaultLayer: true, staticGeometry: true, player: true, character: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  components: [Player],
});

/** A house: a static box. */
export const House = prefab({
  name: 'house',
  body: {
    shape: 'box',
    dims: HOUSE_HALF,
    kind: 'fixed',
    layer: { defaultLayer: true },
    mask: { player: true, character: true },
  },
  components: [Home],
});

/** A front door: kinematic, because it slides and nothing pushes it. */
export const FrontDoor = prefab({
  name: 'door',
  body: {
    shape: 'box',
    dims: DOOR_HALF,
    kind: 'kinematic',
    layer: { defaultLayer: true },
    mask: { player: true, character: true },
  },
  components: [Door],
});

/** A car: kinematic, moved by its driver's keys (`src/systems/drive.ts`). */
export const Sedan = prefab({
  name: 'car',
  body: {
    shape: 'box',
    dims: CAR_HALF,
    kind: 'kinematic',
    layer: { defaultLayer: true },
    mask: { player: true, character: true },
  },
  components: [Car],
});

/** A bench: a static box to sit on. */
export const ParkBench = prefab({
  name: 'bench',
  body: {
    shape: 'box',
    dims: BENCH_HALF,
    kind: 'fixed',
    layer: { defaultLayer: true },
    mask: { player: true, character: true },
  },
  components: [Bench],
});

/**
 * Paint an entity: its placeholder box, or its character's materials. One
 * `set-material-param` command, which the room keeps and hands to anyone who
 * joins later. Call it on a change, never every tick.
 *
 * @param entity The entity.
 * @param r Linear red, 0..1.
 * @param g Linear green, 0..1.
 * @param b Linear blue, 0..1.
 */
export function tint(entity: number, r: number, g: number, b: number): void {
  activeRuntime().commands.setMaterialParam(entity, 'color', {
    tag: 'color',
    val: { r, g, b, a: 1 },
  });
}

/** House walls, door wood, car paint and bench wood, linear RGB. */
export const COLOURS = {
  house: [0.62, 0.58, 0.52],
  door: [0.4, 0.24, 0.14],
  car: [0.7, 0.12, 0.1],
  bench: [0.3, 0.2, 0.12],
} as const;
