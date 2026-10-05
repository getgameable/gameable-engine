/**
 * What a fighter is made of. A prefab is a pure declaration, safe at module
 * scope; `ctx.spawn(Prefab, position)` turns one into an entity.
 *
 * There are two, with the same body: `Fighter` is the one the authority
 * spawns for every player and everyone sees; `OwnBody` is the invisible
 * capsule a player's own page spawns for itself to predict on
 * (`features.multiplayer.predict`). The two bodies must stay identical, or
 * every step of the page's prediction is a correction.
 */
import { activeRuntime, Player, prefab, type BodySpec } from 'gameable';

/** Capsule radius, metres. */
export const RADIUS = 0.35;
/** Half-height of the capsule's cylinder, metres. */
export const HALF_HEIGHT = 0.8;

/** The one body both prefabs carry. */
const BODY: BodySpec = {
  shape: 'capsule',
  dims: [RADIUS, HALF_HEIGHT],
  kind: 'character',
  mass: 75,
  layer: { player: true },
  mask: { defaultLayer: true, staticGeometry: true, player: true },
  flags: { lockRotation: true, noSleep: true },
};

/** Every player, as the room sees them: the sample character on a capsule. */
export const Fighter = prefab({
  name: 'fighter',
  character: 'char.fighter',
  body: BODY,
  components: [Player],
});

/** This page's own body, never shared: the page moves it on key-down. */
export const OwnBody = prefab({ name: 'own-body', body: BODY });

/**
 * Paint a fighter: white is normal, red is the hit flash. Only on the steps
 * the colour changes, never every frame.
 *
 * @param entity The fighter.
 * @param r Red, 0..1.
 * @param g Green, 0..1.
 * @param b Blue, 0..1.
 */
export function tint(entity: number, r: number, g: number, b: number): void {
  colour.val.r = r;
  colour.val.g = g;
  colour.val.b = b;
  activeRuntime().commands.setMaterialParam(entity, 'color', colour);
}

/** The one material value `tint` writes, reused: a system must not allocate. */
const colour = { tag: 'color' as const, val: { r: 1, g: 1, b: 1, a: 1 } };
