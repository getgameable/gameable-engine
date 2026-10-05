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
 */
import { activeRuntime, Enemy, Pickup, Player, prefab } from 'gameable';

/** Player capsule radius, metres. */
export const PLAYER_RADIUS = 0.35;
/** Half-height of the player capsule's cylindrical section, metres. */
export const PLAYER_HALF_HEIGHT = 0.8;
/**
 * Height of the player capsule's centre above its feet.
 *
 * A Jolt capsule's origin is its centre, so a spawn point on the floor has to
 * be lifted by this much or the player starts buried.
 */
export const PLAYER_CENTRE = PLAYER_RADIUS + PLAYER_HALF_HEIGHT;
/** Eye height above the entity origin: 1.7 m above the floor. */
export const EYE_OFFSET = 1.7 - PLAYER_CENTRE;

/** Enemy capsule radius, metres. */
export const ENEMY_RADIUS = 0.35;
/** Half-height of an enemy capsule's cylindrical section, metres. */
export const ENEMY_HALF_HEIGHT = 0.7;
/** Height of an enemy capsule's centre above its feet. */
export const ENEMY_CENTRE = ENEMY_RADIUS + ENEMY_HALF_HEIGHT;

/** Half-extent of a medkit box, metres. */
export const MEDKIT_HALF = 0.22;

/**
 * The player: an invisible capsule driven by the host character controller.
 *
 * It has no `asset`, and the first-person camera hides whatever entity it is
 * mounted on, so nothing is drawn where your eyes are.
 */
export const PlayerPrefab = prefab({
  name: 'player',
  body: {
    shape: 'capsule',
    dims: [PLAYER_RADIUS, PLAYER_HALF_HEIGHT],
    kind: 'character',
    mass: 80,
    layer: { player: true },
    mask: { staticGeometry: true, enemy: true, pickup: true },
    flags: { reportContacts: true, lockRotation: true, noSleep: true },
  },
  health: 100,
  components: [Player],
});

/**
 * An enemy: a red person who walks at you and hits you.
 *
 * `character` names an entry in `src/assets.json`; the host draws that rig
 * instead of the capsule and blends its clips from `character.setState`.
 */
export const EnemyPrefab = prefab({
  name: 'enemy',
  character: 'char.enemy',
  body: {
    shape: 'capsule',
    dims: [ENEMY_RADIUS, ENEMY_HALF_HEIGHT],
    kind: 'character',
    mass: 70,
    layer: { enemy: true },
    mask: { staticGeometry: true, player: true, enemy: true },
    flags: { reportContacts: true, noSleep: true },
  },
  health: 40,
  components: [Enemy],
});

/** A medkit: a small green box you walk into. */
export const MedkitPrefab = prefab({
  name: 'medkit',
  body: {
    shape: 'box',
    dims: [MEDKIT_HALF, MEDKIT_HALF, MEDKIT_HALF],
    kind: 'fixed',
    layer: { pickup: true },
    mask: { player: true },
    flags: { sensor: true },
  },
  components: [Pickup],
});

/**
 * Paint an entity: its placeholder mesh, or its character's materials.
 *
 * `set-material-param` is a normal frame-output command; there is no facade
 * for it on `ctx` because a real game sets a material through its asset, not
 * through a uniform. Call it right after `ctx.spawn`, once, never per frame.
 *
 * @param entity The entity to paint.
 * @param r Red, 0..1.
 * @param g Green, 0..1.
 * @param b Blue, 0..1.
 * @returns Nothing.
 */
export function tint(entity: number, r: number, g: number, b: number): void {
  activeRuntime().commands.setMaterialParam(entity, 'color', {
    tag: 'color',
    val: { r, g, b, a: 1 },
  });
}

/** Enemy red. */
export const ENEMY_COLOUR: readonly [number, number, number] = [0.82, 0.18, 0.16];

/** Medkit green. */
export const MEDKIT_COLOUR: readonly [number, number, number] = [0.16, 0.78, 0.4];
