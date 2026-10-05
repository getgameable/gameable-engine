/**
 * The WIT body vocabulary in the physics module's spelling.
 *
 * Pure mappings from an `add-body` command's kind, shape and collision layers
 * to the arguments `PhysicsWorld.addBody` takes, shared by the page's
 * `createEngineAdapter` and the server's `ServerAdapter` so the two hosts
 * build identical bodies from identical commands.
 */
import type { BodyArgs, GroundState } from '@gameable/physics-jolt';
import type { AddBodyCmd, CollisionLayers, ShapeKind, Vec3 } from '@gameable/sdk';

/**
 * WIT `collision-layers` members, in declaration order. Bit `i` of the
 * physics module's numeric layer/mask is member `i` of this list, and the
 * guest's `packages/sdk/src/prefab.ts` uses the same order.
 */
const LAYER_KEYS = [
  'defaultLayer',
  'staticGeometry',
  'player',
  'enemy',
  'projectile',
  'pickup',
  'trigger',
  'character',
  'debris',
  'water',
  'user0',
  'user1',
  'user2',
  'user3',
  'user4',
  'user5',
] as const satisfies readonly (keyof CollisionLayers)[];

/** Floats per packed body row, as `PhysicsWorld.readBodies` writes them. */
export const BODY_STRIDE = 15;

/** Upward speed given to a `move-character` with `jump` and no explicit `y`. */
export const DEFAULT_JUMP_SPEED = 5;

/**
 * `move-character`'s default walkable slope, which is also the physics
 * module's own. A guest asking for exactly this is asking for the default, so
 * a module that cannot honour the field owes no warning.
 */
export const DEFAULT_MAX_SLOPE_DEG = 45;

/** Physics body classes, as this module spells them for the physics module. */
export type JoltBodyKind = 'static' | 'dynamic' | 'kinematic' | 'character';

/** Collision shapes the physics module understands. */
export type JoltShapeKind = 'box' | 'sphere' | 'capsule' | 'cylinder' | 'mesh' | 'convex';

/**
 * Turn a WIT flags record into the bitset the physics module wants.
 *
 * @param layers The flags record, with every member present.
 * @returns A 16-bit mask.
 */
export function layerBits(layers: CollisionLayers): number {
  let bits = 0;
  for (let i = 0; i < LAYER_KEYS.length; i += 1) {
    if (layers[LAYER_KEYS[i]] === true) bits |= 1 << i;
  }
  return bits;
}

/**
 * Map the WIT body class onto the physics module's spelling.
 *
 * WIT says `fixed` because `static` is a reserved word there.
 *
 * @param kind The WIT body kind.
 * @returns The physics module's body kind.
 */
export function bodyKind(kind: AddBodyCmd['kind']): JoltBodyKind {
  return kind === 'fixed' ? 'static' : kind;
}

/**
 * Map the WIT shape family onto the physics module's spelling.
 *
 * @param kind The WIT shape kind.
 * @returns The physics module's shape kind, or null when it has no equivalent.
 */
export function shapeKind(kind: ShapeKind): JoltShapeKind | null {
  switch (kind) {
    case 'box':
    case 'sphere':
    case 'capsule':
    case 'cylinder':
    case 'mesh':
      return kind;
    case 'convex-hull':
      return 'convex';
    default:
      // `plane` and `height-field` have no direct Jolt equivalent here.
      return null;
  }
}

/**
 * Shape dimensions, in the lane order the physics module documents.
 *
 * @param kind The physics shape kind.
 * @param half The WIT half-extents record.
 * @returns The `dims` array.
 */
export function shapeDims(kind: JoltShapeKind, half: Vec3): number[] {
  switch (kind) {
    case 'sphere':
      return [half.x];
    case 'capsule':
    case 'cylinder':
      return [half.x, half.y];
    default:
      return [half.x, half.y, half.z];
  }
}

/** Shapes a guest `add-body` can build by itself; `mesh` and `convex` need a collider asset. */
export type GuestShapeKind = Exclude<JoltShapeKind, 'mesh' | 'convex'>;

/** Why an `add-body` was not forwarded: a warn-once key and its deferred message. */
export interface BodySkip {
  /** Deduplication key. */
  key: string;
  /** Builds the message, only the first time the key is warned. */
  message: () => string;
}

/**
 * Can the guest's command build this body without the host's help?
 *
 * @param kind The mapped shape kind, or null when Jolt has none.
 * @returns True for a primitive shape.
 */
export function isGuestShape(kind: JoltShapeKind | null): kind is GuestShapeKind {
  return kind !== null && kind !== 'mesh' && kind !== 'convex';
}

/**
 * The warning for an `add-body` whose shape the guest cannot build.
 *
 * @param shape The WIT shape kind the guest sent.
 * @param kind The mapped kind that failed {@link isGuestShape}.
 * @returns The warn-once key and message.
 */
export function addBodySkip(shape: ShapeKind, kind: 'mesh' | 'convex' | null): BodySkip {
  if (kind === null) {
    return {
      key: `no-jolt-shape:${shape}`,
      message: () => `gameable: shape "${shape}" has no Jolt equivalent; body skipped`,
    };
  }
  return {
    key: `host-shape:${shape}`,
    message: () =>
      `gameable: a "${shape}" body must be built by the host from its ` +
      'collider asset; the guest command is ignored',
  };
}

/**
 * The physics module's `addBody` arguments for a guest `add-body`.
 *
 * @param args The guest's command.
 * @param kind Its mapped primitive shape.
 * @returns A fresh argument object (spawn-time, so allocating is fine).
 */
export function toJoltBody(args: AddBodyCmd, kind: GuestShapeKind): BodyArgs {
  return {
    id: args.body,
    shape: kind,
    dims: shapeDims(kind, args.shape.halfExtents),
    position: [args.position.x, args.position.y, args.position.z],
    rotation: [args.rotation.x, args.rotation.y, args.rotation.z, args.rotation.w],
    mass: args.mass,
    kind: bodyKind(args.kind),
    layer: layerBits(args.layer),
    mask: layerBits(args.mask),
    friction: args.friction,
    restitution: args.restitution,
    linearDamping: args.linearDamping,
    angularDamping: args.angularDamping,
    flags: {
      reportContacts: args.flags.reportContacts,
      sensor: args.flags.sensor,
      noSleep: args.flags.noSleep,
      lockRotation: args.flags.lockRotation,
      ccd: args.flags.ccd,
    },
  };
}

/**
 * The upward speed a `move-character` hands the physics module.
 *
 * The module reads a positive `y` as a jump request while grounded, so `jump`
 * only has to supply a speed when the guest did not.
 *
 * @param vy The guest's desired vertical speed.
 * @param jump Whether the guest asked to jump.
 * @param world Asked for the body's ground state, only when it matters.
 * @param body The character body.
 * @returns The vertical speed to send.
 */
export function jumpSpeed(vy: number, jump: boolean, world: GroundProbe, body: number): number {
  if (jump && vy <= 0 && world.groundState(body) === 'on-ground') return DEFAULT_JUMP_SPEED;
  return vy;
}

/** Anything that can report a character body's ground state. */
export interface GroundProbe {
  /**
   * @param id Body id.
   * @returns Whether the body stands on something.
   */
  groundState(id: number): GroundState;
}

/** Warn-once key (and message) for a crouch the physics module cannot do. */
export const CROUCH_UNSUPPORTED =
  'gameable: move-character crouch is not implemented by the physics module';

/** Warn-once key for a slope limit the physics module cannot honour. */
export const SLOPE_UNSUPPORTED = 'move-character:maxSlopeDeg';

/** @returns The message for {@link SLOPE_UNSUPPORTED}, built only when first warned. */
export const slopeUnsupportedMessage = (): string =>
  'gameable: move-character maxSlopeDeg is not implemented by the physics module; ' +
  `every character walks the module's own ${String(DEFAULT_MAX_SLOPE_DEG)}-degree limit`;

/**
 * Tell the game which `move-character` fields a two-argument physics module dropped.
 *
 * @param crouch The guest's crouch request.
 * @param maxSlopeDeg The guest's slope limit.
 * @param warn A warn-once sink taking a key and a deferred message.
 */
export function warnDroppedMoveFields(
  crouch: boolean,
  maxSlopeDeg: number,
  warn: (key: string, build?: () => string) => void,
): void {
  if (crouch) warn(CROUCH_UNSUPPORTED);
  if (maxSlopeDeg !== DEFAULT_MAX_SLOPE_DEG) warn(SLOPE_UNSUPPORTED, slopeUnsupportedMessage);
}
