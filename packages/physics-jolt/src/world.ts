import type { JoltInstance, JoltModule, JoltShape } from './jolt.js';
import { LayerTable, type LayerOptions } from './layers.js';

/** Floats per row in the buffer {@link PhysicsWorld.readBodies} fills. */
export const BODY_STRIDE = 15;

/** Floats per row of the input buffer {@link PhysicsWorld.raycastBatch} reads. */
export const RAY_STRIDE = 7;

/** Floats per row of the output buffer {@link PhysicsWorld.raycastBatch} fills. */
export const RAY_HIT_STRIDE = 9;

/** A position or direction, in metres. */
export type Vec3 = readonly [number, number, number];

/** A unit quaternion in xyzw order, matching three.js and Jolt. */
export type Quat = readonly [number, number, number, number];

/** Collision shape family. Mirrors WIT `shape-kind`. */
export type ShapeKind = 'box' | 'sphere' | 'capsule' | 'cylinder' | 'mesh' | 'convex';

/**
 * Body class. Mirrors WIT `body-kind`, except that WIT spells `static` as
 * `fixed` because `static` is a WIT keyword.
 */
export type BodyKind = 'static' | 'dynamic' | 'kinematic' | 'character';

/** Which side of a contact this record describes. Mirrors WIT `contact-phase`. */
export type ContactPhase = 'begin' | 'stay' | 'end';

/** What a character controller is standing on. */
export type GroundState = 'on-ground' | 'on-steep-ground' | 'not-supported' | 'in-air';

/** Per-body switches. Mirrors WIT `body-flags`. */
export interface BodyFlags {
  /**
   * Emit this body's contacts from {@link PhysicsWorld.drainContacts}.
   *
   * **Off by default.** A world of resting crates generates a manifold per
   * touching pair per step whether or not anyone reads it, and turning those
   * into records costs a wasm crossing each. Ask for contacts on the handful of
   * bodies whose collisions the game reacts to — the player, projectiles,
   * triggers — and the rest cost nothing at all.
   */
  reportContacts?: boolean;
  /**
   * Also emit the `stay` phase, once per step for as long as the pair touches.
   *
   * Off by default, and only meaningful together with
   * {@link BodyFlags.reportContacts}: `begin` and `end` are edges, so a game
   * that tracks "am I touching this" needs no more than those two. `stay` is
   * the expensive one — a box resting on the floor emits it sixty times a
   * second forever — so it is separately opt-in, for the rare system that
   * wants a live contact point (a grinding-sparks effect, a pressure plate
   * that weighs what is on it).
   */
  reportStay?: boolean;
  /** Trigger volume: generates contacts but no collision response. */
  sensor?: boolean;
  /** Never let the solver put this body to sleep. */
  noSleep?: boolean;
  /** Lock all rotation. The usual choice for a capsule. */
  lockRotation?: boolean;
  /** Use continuous collision detection (linear cast). */
  ccd?: boolean;
}

/**
 * Everything needed to create one body. Mirrors the WIT `add-body` command,
 * minus the entity handle, which the host module owns.
 */
export interface BodyArgs {
  /** Guest-minted handle. Must not already exist in this world. */
  id: number;
  /** Shape family. `mesh` and `convex` additionally need {@link BodyArgs.geometry}. */
  shape: ShapeKind;
  /**
   * Shape dimensions, in metres:
   * `box` half-extents `[hx, hy, hz]`; `sphere` `[radius]`;
   * `capsule` and `cylinder` `[radius, halfHeight]`. Ignored for `mesh` and
   * `convex`.
   */
  dims: readonly number[];
  /** World-space position of the body origin. */
  position: Vec3;
  /** World-space orientation, xyzw. */
  rotation: Quat;
  /** Kilograms. Ignored for `static`, `kinematic` and `character` bodies. */
  mass: number;
  /** Body class. */
  kind: BodyKind;
  /** What this body *is*, as a bitset. */
  layer: number;
  /** What this body collides with, as a bitset of other bodies' layers. */
  mask: number;
  /** Coulomb friction, 0..1. */
  friction: number;
  /** Bounciness, 0..1. */
  restitution: number;
  /** Linear velocity damping per second. Defaults to 0.05, Jolt's own default. */
  linearDamping?: number;
  /** Angular velocity damping per second. Defaults to 0.05. */
  angularDamping?: number;
  /** Optional switches. */
  flags?: BodyFlags;
  /**
   * Prebuilt shape for `mesh` and `convex` bodies, from
   * `meshShapeFromGeometry` or `convexHullFromPoints`. The world takes its own
   * reference, so one shape can back many bodies.
   */
  geometry?: JoltShape;
}

/**
 * One contact event. Instances are pooled by the world and by the caller's
 * `out` array; copy anything you want to keep past the next `drainContacts`.
 */
export interface ContactRecord {
  /** Guest body id of the first body. */
  a: number;
  /** Guest body id of the second body. */
  b: number;
  /** Whether the contact started, continued or ended. */
  phase: ContactPhase;
  /** World-space contact point, x. Zero for `end`. */
  px: number;
  /** World-space contact point, y. Zero for `end`. */
  py: number;
  /** World-space contact point, z. Zero for `end`. */
  pz: number;
  /** Contact normal pointing from `a` towards `b`, x. Zero for `end`. */
  nx: number;
  /** Contact normal, y. */
  ny: number;
  /** Contact normal, z. */
  nz: number;
  /**
   * Estimated normal impulse, newton-seconds. Jolt does not hand the solved
   * impulse to a contact listener, so this is `reduced mass * closing speed`
   * measured before the solve: right in order of magnitude, good enough to
   * scale an impact sound, not a physical measurement.
   */
  impulse: number;
}

/** One raycast result. The instance returned by `raycast` is reused. */
export interface RayHit {
  /** Guest body id that was hit. */
  body: number;
  /** Hit point, x. */
  px: number;
  /** Hit point, y. */
  py: number;
  /** Hit point, z. */
  pz: number;
  /** Surface normal at the hit, x. */
  nx: number;
  /** Surface normal, y. */
  ny: number;
  /** Surface normal, z. */
  nz: number;
  /** Distance from the ray origin, metres. */
  distance: number;
}

/** Options for {@link createPhysicsWorld}. */
export interface PhysicsWorldOptions {
  /** Gravity in metres per second squared. Defaults to `[0, -9.81, 0]`. */
  gravity?: Vec3;
  /** Hard ceiling on simultaneous bodies. Defaults to 4096. */
  maxBodies?: number;
  /** Object-layer slot tuning. See {@link LayerOptions}. */
  layers?: LayerOptions;
  /** Maximum body pairs the broad phase tracks. Defaults to `maxBodies * 2`. */
  maxBodyPairs?: number;
  /** Maximum contact constraints per step. Defaults to `maxBodies`. */
  maxContactConstraints?: number;
  /**
   * Contact records the world keeps for one step. Defaults to 256.
   *
   * The pool is allocated up front and never grows, because growing it would
   * allocate inside Jolt's own `Step()`. A step that produces more reportable
   * contacts than this drops the surplus and warns once — raise the ceiling if
   * the game really does want that many in a single step.
   */
  maxContactsPerStep?: number;
}

/**
 * A live Jolt simulation. Everything the engine's physics command stream and
 * synchronous query imports need, and nothing else.
 */
export interface PhysicsWorld {
  /** Create a body. See {@link BodyArgs}. */
  addBody(args: BodyArgs): void;
  /** Destroy a body and release its shape reference. Unknown ids are ignored. */
  removeBody(id: number): void;
  /**
   * Teleport a body. Velocities are left alone unless `teleport` says otherwise.
   *
   * @param id Guest body handle.
   * @param position New world-space position.
   * @param rotation New world-space orientation, xyzw.
   * @param teleport True for a hard cut: the body's linear and angular
   *   velocities are zeroed too, and a character forgets the velocity it was
   *   asked for. False (the default) moves the body and lets it keep moving.
   */
  setTransform(id: number, position: Vec3, rotation: Quat, teleport?: boolean): void;
  /** Set linear and angular velocity. */
  setVelocity(id: number, linear: Vec3, angular: Vec3): void;
  /** Apply an impulse, at the centre of mass unless `point` says otherwise. */
  applyImpulse(id: number, impulse: Vec3, point?: Vec3): void;
  /** Take a body out of the simulation without destroying it, or put it back. */
  setEnabled(id: number, enabled: boolean): void;
  /** Set the desired world-space velocity of a `character` body for the next step. */
  moveCharacter(id: number, desiredVelocity: Vec3): void;
  /** What a `character` body is standing on, as of the last step. */
  groundState(id: number): GroundState;
  /** Advance the simulation. */
  step(dt: number, substeps?: number): number;
  /** Write stride-15 body rows into `out`. See {@link PhysicsWorld.readBodies}. */
  readBodies(out: Float32Array): number;
  /** Move queued contacts into `out`. */
  drainContacts(out: ContactRecord[]): number;
  /** Closest hit along a ray, or null. The returned object is reused. */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, mask: number): RayHit | null;
  /** Many rays, one call. */
  raycastBatch(rays: Float32Array, mask: number, out: Float32Array): number;
  /** Guest body ids overlapping a sphere, nearest first. */
  overlapSphere(center: Vec3, radius: number, mask: number): number[];
  /** Zero-allocation form of {@link PhysicsWorld.overlapSphere}. */
  overlapSphereInto(center: Vec3, radius: number, mask: number, out: Uint32Array): number;
  /** Number of bodies currently in the world. */
  readonly bodyCount: number;
  /**
   * Rows {@link PhysicsWorld.readBodies} would write: the non-static, enabled
   * bodies. Size the destination from this and `readBodies` never has to be
   * called twice.
   */
  readonly movingBodyCount: number;
  /**
   * Bumped whenever the set of bodies changes: add, remove or enable/disable.
   * Debug views rebuild their geometry when this moves and not otherwise.
   */
  readonly revision: number;
  /** Snapshot of the live body ids, cheap and non-allocating to iterate. */
  bodyIds(): readonly number[];
  /** Local-space bounds and world transform of a body, for debug drawing. */
  readBodyBounds(id: number, out: Float32Array, offset: number): boolean;
  /** World transform of a body alone, when its bounds are already known. */
  readBodyPose(id: number, out: Float32Array, offset: number): boolean;
  /** Free every Jolt object this world owns. */
  dispose(): void;
}

/**
 * Allocate one pooled {@link ContactRecord}.
 *
 * @returns A zeroed record.
 *
 * @example
 * ```ts
 * import { createContactRecord, type ContactRecord } from 'gameable/physics';
 *
 * const pool: ContactRecord[] = [createContactRecord(), createContactRecord()];
 * ```
 */
export function createContactRecord(): ContactRecord {
  return { a: 0, b: 0, phase: 'begin', px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, impulse: 0 };
}

/** Degrees to radians. */
const DEG2RAD = Math.PI / 180;

/**
 * Max walkable slope for a character, in degrees.
 *
 * Jolt's own default is 50°, which feels slack in a shooter: it lets a player
 * walk up scenery an artist drew as a wall. 45° is the engine's choice and the
 * one `move-character`'s `max-slope-deg` field defaults to, so a guest that
 * says nothing and a guest that says 45 mean the same thing.
 */
const MAX_SLOPE_DEG = 45;

/**
 * Jolt broad-phase layer holding the static bodies, as {@link LayerTable} maps
 * them.
 */
const BP_STATIC = 0;

/** Jolt broad-phase layer holding the moving bodies. */
const BP_MOVING = 1;

/** Placeholder destination for `overlapSphere`, which reads the internal buffer. */
const EMPTY_IDS = new Uint32Array(0);

/**
 * A convex radius that never exceeds the shape it rounds off.
 *
 * @param smallestHalfExtent The tightest half-extent of the shape, in metres.
 * @returns A safe convex radius.
 */
function convexRadius(smallestHalfExtent: number): number {
  return Math.min(0.05, Math.max(smallestHalfExtent * 0.25, 0));
}

/**
 * The binder helpers the Jolt type declarations leave out.
 *
 * `jolt-physics` ships a WebIDL binder whose wrapper objects are **interned**:
 * `wrapPointer(ptr, Class)` caches one JS object per `(class, pointer)` pair
 * forever, and only `destroy()` evicts an entry. That is fine for the handful
 * of long-lived objects a world owns, and a slow leak for the short-lived ones
 * Jolt hands a contact listener — a `SubShapeIDPair` lives on the stack, so
 * every removed contact interns a fresh wrapper at a fresh address. The three
 * helpers below are what it takes to evict one; they exist on the module but
 * not in its `.d.ts`, so this interface names them.
 */
interface BinderApi {
  /**
   * The wrapper cache for one bound class.
   *
   * @param cls The class, or undefined for the base class.
   * @returns The live cache object, keyed by pointer.
   */
  getCache(cls: unknown): Record<number, unknown>;
  /**
   * The class a wrapper belongs to.
   *
   * @param wrapper A wrapper from `wrapPointer`.
   * @returns The class, as {@link BinderApi.getCache} wants it.
   */
  getClass(wrapper: unknown): unknown;
  /**
   * The wasm address behind a wrapper.
   *
   * @param wrapper A wrapper from `wrapPointer`.
   * @returns The pointer; `0` for a null result.
   */
  getPointer(wrapper: unknown): number;
}

/** Internal bookkeeping for one body. */
interface BodyRecord {
  /** Guest handle. */
  id: number;
  /** Owned copy of the Jolt handle. `CreateAndAddBody` returns a shared temporary. */
  joltId: JoltInstance<'BodyID'>;
  /** `GetIndexAndSequenceNumber()` of `joltId`, the reverse-map key. */
  joltKey: number;
  /** Body class. */
  kind: BodyKind;
  /** Shape this body was built with; the world holds one reference. */
  shape: JoltShape;
  /** What the body is. */
  layer: number;
  /** What the body collides with. */
  mask: number;
  /** False while the body is out of the simulation. */
  enabled: boolean;
  /** True when contacts involving this body are queued. */
  reportContacts: boolean;
  /** True when `stay` manifolds involving this body are queued too. */
  reportStay: boolean;
  /**
   * The 13 floats after the id of this body's last {@link readBodies} row.
   *
   * A sleeping body has not moved since it was last read, so replaying this is
   * exactly right and costs one wasm crossing (`IsActive`) instead of fifteen.
   * Kept on the record rather than in a row-indexed mirror because rows shift
   * whenever a body is added, removed, enabled or disabled.
   */
  readonly row: Float32Array;
  /** False until {@link row} holds a real read; a fresh body must fall through. */
  rowValid: boolean;
  /** The controller, for `character` bodies. */
  character: JoltInstance<'CharacterVirtual'> | null;
  /** Desired velocity for the next character step. */
  desiredX: number;
  /** Desired velocity for the next character step. */
  desiredY: number;
  /** Desired velocity for the next character step. */
  desiredZ: number;
}

/**
 * Create a Jolt simulation.
 *
 * @param jolt The module from {@link loadJolt}.
 * @param options Gravity, capacity and layer tuning.
 * @returns A live world. Call {@link PhysicsWorld.dispose} when done.
 *
 * @example
 * ```ts
 * import { createPhysicsWorld, loadJolt } from 'gameable/physics';
 *
 * const world = createPhysicsWorld(await loadJolt(), { gravity: [0, -9.81, 0] });
 * world.addBody({
 *   id: 1,
 *   shape: 'box',
 *   dims: [10, 0.5, 10],
 *   position: [0, -0.5, 0],
 *   rotation: [0, 0, 0, 1],
 *   mass: 0,
 *   kind: 'static',
 *   layer: 0b10,
 *   mask: 0xffff,
 *   friction: 0.6,
 *   restitution: 0,
 * });
 * world.step(1 / 60);
 * world.dispose();
 * ```
 */
export function createPhysicsWorld(
  jolt: JoltModule,
  options: PhysicsWorldOptions = {},
): PhysicsWorld {
  return new JoltPhysicsWorld(jolt, options);
}

/** The one implementation of {@link PhysicsWorld}. */
class JoltPhysicsWorld implements PhysicsWorld {
  readonly #jolt: JoltModule;
  readonly #layers: LayerTable;
  readonly #interface: JoltInstance<'JoltInterface'>;
  readonly #system: JoltInstance<'PhysicsSystem'>;
  readonly #bodies: JoltInstance<'BodyInterface'>;
  readonly #lock: JoltInstance<'BodyLockInterfaceNoLock'>;
  readonly #tempAllocator: JoltInstance<'TempAllocator'>;

  /** The binder helpers the Jolt typings omit; see {@link BinderApi}. */
  readonly #binder: BinderApi;

  /** Guest id to record. */
  readonly #byId = new Map<number, BodyRecord>();
  /** Jolt `indexAndSequence` to guest id, for query and contact results. */
  readonly #byJolt = new Map<number, number>();
  /**
   * Jolt keys to forget once the current step has finished emitting contacts,
   * as `[key, id, key, id, ...]`.
   *
   * The id is kept because Jolt reuses an index-and-sequence number: a body
   * removed and another added in the same step can land on the same key, and
   * unmapping by key alone would then delete the *new* body's mapping.
   */
  readonly #unmapAfterStep: number[] = [];
  /** Guest ids of enabled non-static bodies, ascending. The `readBodies` order. */
  readonly #movingIds: number[] = [];
  /** Guest ids of every live body, ascending. */
  readonly #allIds: number[] = [];
  /** Character records, iterated every step. */
  readonly #characters: BodyRecord[] = [];

  /** Pooled contact records, allocated once and reused forever. */
  readonly #contactPool: ContactRecord[];
  /** How many entries of {@link JoltPhysicsWorld.#contactPool} are live. */
  #contactCount = 0;
  /** True once a step has overflowed the pool, so the warning fires once. */
  #warnedOverflow = false;

  /** Bodies with `reportContacts`; zero means the listener can leave at once. */
  #reportingBodies = 0;
  /** Bodies with `reportStay`; zero means `OnContactPersisted` is free. */
  #stayBodies = 0;

  /**
   * `1` for every object-layer slot the current query mask accepts, so the
   * `ShouldCollide` callback Jolt invokes per broad-phase candidate is one
   * typed-array read rather than a method call and a masked lookup.
   */
  #acceptSlots: Uint8Array;
  /** Layer-table revision {@link JoltPhysicsWorld.#acceptSlots} was built for. */
  #acceptRevision = -1;
  /** Mask {@link JoltPhysicsWorld.#acceptSlots} was built for. */
  #acceptMask = -1;

  /** Bumped on every structural change. */
  #revision = 0;

  /** Gravity, kept in JS so the character integrator does not round-trip. */
  readonly #gravity: [number, number, number];

  // --- Jolt scratch objects. Allocated once, mutated in place, never per frame.
  readonly #gravityVec: JoltInstance<'Vec3'>;
  readonly #tmpVec3: JoltInstance<'Vec3'>;
  readonly #tmpVec3b: JoltInstance<'Vec3'>;
  readonly #tmpRVec3: JoltInstance<'RVec3'>;
  readonly #tmpRVec3b: JoltInstance<'RVec3'>;
  readonly #tmpQuat: JoltInstance<'Quat'>;
  readonly #zeroOffset: JoltInstance<'RVec3'>;
  readonly #ray: JoltInstance<'RRayCast'>;
  readonly #raySettings: JoltInstance<'RayCastSettings'>;
  readonly #rayCollector: JoltInstance<'CastRayClosestHitCollisionCollector'>;
  readonly #overlapShape: JoltInstance<'SphereShape'>;
  readonly #overlapSettings: JoltInstance<'CollideShapeSettings'>;
  readonly #overlapCollector: JoltInstance<'CollideShapeAllHitCollisionCollector'>;
  readonly #broadPhaseFilter: JoltInstance<'BroadPhaseLayerFilter'>;
  /** Broad-phase filter that visits only the static tree. */
  readonly #broadPhaseStatic: JoltInstance<'SpecifiedBroadPhaseLayerFilter'>;
  /** Broad-phase filter that visits only the moving tree. */
  readonly #broadPhaseMoving: JoltInstance<'SpecifiedBroadPhaseLayerFilter'>;
  readonly #objectLayerFilter: JoltInstance<'ObjectLayerFilterJS'>;
  readonly #bodyFilter: JoltInstance<'BodyFilter'>;
  readonly #shapeFilter: JoltInstance<'ShapeFilter'>;
  readonly #extendedUpdate: JoltInstance<'ExtendedUpdateSettings'>;
  readonly #contactListener: JoltInstance<'ContactListenerJS'>;

  /** Reused raycast result. */
  readonly #hit: RayHit = { body: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, distance: 0 };

  /** Scratch for {@link PhysicsWorld.overlapSphereInto} sorting. */
  #overlapIds = new Uint32Array(64);
  /** Scratch for {@link PhysicsWorld.overlapSphereInto} sorting. */
  #overlapDist = new Float64Array(64);
  /**
   * Epoch stamp per guest body id, so `overlapSphereInto` dedupes in O(1)
   * rather than scanning what it has already found. Indexed by body id and
   * compared against {@link JoltPhysicsWorld.#overlapEpoch}, so no clearing
   * pass is needed between queries. Sized for ids up to `maxBodies` in the
   * constructor (the guest's and a room's host-owned level ids), so a query
   * allocates only for an id above that.
   */
  #overlapSeen: Uint32Array;
  /** Bumped by every `overlapSphereInto`; see {@link JoltPhysicsWorld.#overlapSeen}. */
  #overlapEpoch = 0;

  /** True once {@link PhysicsWorld.dispose} has run. */
  #disposed = false;

  /**
   * @param jolt The initialised Jolt module.
   * @param options World tuning.
   */
  constructor(jolt: JoltModule, options: PhysicsWorldOptions) {
    this.#jolt = jolt;
    this.#binder = jolt as unknown as BinderApi;
    const contacts = Math.max(1, options.maxContactsPerStep ?? 256);
    this.#contactPool = new Array<ContactRecord>(contacts);
    for (let i = 0; i < contacts; i += 1) this.#contactPool[i] = createContactRecord();
    const gravity = options.gravity ?? [0, -9.81, 0];
    this.#gravity = [gravity[0], gravity[1], gravity[2]];
    const maxBodies = options.maxBodies ?? 4096;
    this.#overlapSeen = new Uint32Array(maxBodies + 1);

    this.#layers = new LayerTable(jolt, options.layers);
    this.#acceptSlots = new Uint8Array(this.#layers.maxObjectLayers);

    const settings = new jolt.JoltSettings();
    settings.mMaxBodies = maxBodies;
    settings.mMaxBodyPairs = options.maxBodyPairs ?? maxBodies * 2;
    settings.mMaxContactConstraints = options.maxContactConstraints ?? maxBodies;
    settings.mObjectLayerPairFilter = this.#layers.pairFilter;
    settings.mBroadPhaseLayerInterface = this.#layers.broadPhase;
    settings.mObjectVsBroadPhaseLayerFilter = this.#layers.objectVsBroadPhase;
    this.#interface = new jolt.JoltInterface(settings);
    jolt.destroy(settings);

    this.#system = this.#interface.GetPhysicsSystem();
    this.#bodies = this.#system.GetBodyInterface();
    this.#lock = this.#system.GetBodyLockInterfaceNoLock();
    this.#tempAllocator = this.#interface.GetTempAllocator();

    this.#gravityVec = new jolt.Vec3(gravity[0], gravity[1], gravity[2]);
    this.#system.SetGravity(this.#gravityVec);

    this.#tmpVec3 = new jolt.Vec3(0, 0, 0);
    this.#tmpVec3b = new jolt.Vec3(0, 0, 0);
    this.#tmpRVec3 = new jolt.RVec3(0, 0, 0);
    this.#tmpRVec3b = new jolt.RVec3(0, 0, 0);
    this.#tmpQuat = new jolt.Quat(0, 0, 0, 1);
    this.#zeroOffset = new jolt.RVec3(0, 0, 0);
    this.#ray = new jolt.RRayCast();
    this.#raySettings = new jolt.RayCastSettings();
    this.#rayCollector = new jolt.CastRayClosestHitCollisionCollector();
    this.#overlapShape = new jolt.SphereShape(1);
    this.#overlapShape.AddRef();
    this.#overlapSettings = new jolt.CollideShapeSettings();
    this.#overlapCollector = new jolt.CollideShapeAllHitCollisionCollector();
    this.#broadPhaseFilter = new jolt.BroadPhaseLayerFilter();
    const bpStatic = new jolt.BroadPhaseLayer(BP_STATIC);
    const bpMoving = new jolt.BroadPhaseLayer(BP_MOVING);
    this.#broadPhaseStatic = new jolt.SpecifiedBroadPhaseLayerFilter(bpStatic);
    this.#broadPhaseMoving = new jolt.SpecifiedBroadPhaseLayerFilter(bpMoving);
    jolt.destroy(bpMoving);
    jolt.destroy(bpStatic);
    this.#bodyFilter = new jolt.BodyFilter();
    this.#shapeFilter = new jolt.ShapeFilter();

    this.#objectLayerFilter = new jolt.ObjectLayerFilterJS();
    // Jolt calls this once per broad-phase candidate, from inside wasm. An
    // array read is the cheapest thing that can happen there; the table behind
    // it is rebuilt only when the mask or the slot set changes.
    const acceptSlots = this.#acceptSlots;
    this.#objectLayerFilter.ShouldCollide = (slot: number): boolean => acceptSlots[slot] === 1;

    this.#extendedUpdate = new jolt.ExtendedUpdateSettings();
    const stepDown = new jolt.Vec3(0, -0.5, 0);
    const stepUp = new jolt.Vec3(0, 0.4, 0);
    this.#extendedUpdate.mStickToFloorStepDown = stepDown;
    this.#extendedUpdate.mWalkStairsStepUp = stepUp;
    jolt.destroy(stepUp);
    jolt.destroy(stepDown);

    this.#contactListener = new jolt.ContactListenerJS();
    this.#installContactListener();
    this.#system.SetContactListener(this.#contactListener);
  }

  // -------------------------------------------------------------------------
  // Bodies
  // -------------------------------------------------------------------------

  /**
   * Create a body.
   *
   * @param args Body description; see {@link BodyArgs}.
   * @throws {Error} When `args.id` already exists or the shape arguments are wrong.
   */
  addBody(args: BodyArgs): void {
    this.#assertLive();
    if (this.#byId.has(args.id)) {
      throw new Error(`body ${String(args.id)} already exists`);
    }
    const jolt = this.#jolt;
    const shape = this.#buildShape(args);
    shape.AddRef();

    const moving = args.kind !== 'static';
    let slot: number;
    try {
      slot = this.#layers.slotFor(args.layer, args.mask, moving);
    } catch (error) {
      // The reference above is the world's own; nothing else will ever drop it,
      // so a body that never gets built has to drop it here or the shape (and,
      // for a mesh collider, its whole BVH) leaks in the wasm heap.
      shape.Release();
      throw error;
    }
    const flags = args.flags ?? {};

    const reportContacts = flags.reportContacts === true;
    const record: BodyRecord = {
      id: args.id,
      joltId: new jolt.BodyID(0),
      joltKey: 0,
      kind: args.kind,
      shape,
      layer: args.layer >>> 0,
      mask: args.mask >>> 0,
      enabled: true,
      reportContacts,
      // `stay` without `begin` and `end` is not a thing a game wants, so the
      // flag only means anything on a body that reports contacts at all.
      reportStay: reportContacts && flags.reportStay === true,
      row: new Float32Array(BODY_STRIDE - 1),
      rowValid: false,
      character: null,
      desiredX: 0,
      desiredY: 0,
      desiredZ: 0,
    };

    if (args.kind === 'character') {
      this.#createCharacter(record, args, shape, slot);
    } else {
      this.#createRigidBody(record, args, shape, slot, flags);
    }

    this.#byId.set(record.id, record);
    this.#byJolt.set(record.joltKey, record.id);
    insertSorted(this.#allIds, record.id);
    if (moving) insertSorted(this.#movingIds, record.id);
    if (record.character !== null) this.#characters.push(record);
    if (record.reportContacts) this.#reportingBodies += 1;
    if (record.reportStay) this.#stayBodies += 1;
    this.#revision += 1;
  }

  /**
   * Destroy a body. Unknown ids are ignored, which keeps command replay simple.
   *
   * @param id Guest body handle.
   */
  removeBody(id: number): void {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined) return;
    const jolt = this.#jolt;

    if (record.character !== null) {
      const index = this.#characters.indexOf(record);
      if (index >= 0) this.#characters.splice(index, 1);
      // The controller owns its inner body and destroys it for us.
      jolt.destroy(record.character);
      record.character = null;
    } else {
      if (record.enabled) this.#bodies.RemoveBody(record.joltId);
      this.#bodies.DestroyBody(record.joltId);
    }
    record.shape.Release();
    jolt.destroy(record.joltId);

    this.#byId.delete(id);
    this.#unmapAfterStep.push(record.joltKey, id);
    removeSorted(this.#allIds, id);
    removeSorted(this.#movingIds, id);
    if (record.reportContacts) this.#reportingBodies -= 1;
    if (record.reportStay) this.#stayBodies -= 1;
    this.#revision += 1;
  }

  /**
   * Move a body. It does not sweep, so it is always a jump rather than a slide.
   *
   * By default the body keeps whatever velocity it had, which is what a game
   * that nudges a moving platform wants. `teleport` makes it a hard cut: the
   * velocities are zeroed as well, so the body arrives at rest and a character
   * forgets the velocity the last `moveCharacter` asked for.
   *
   * @param id Guest body handle.
   * @param position New world-space position.
   * @param rotation New world-space orientation, xyzw.
   * @param teleport Zero the velocities too. Defaults to false.
   */
  setTransform(id: number, position: Vec3, rotation: Quat, teleport = false): void {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined) return;
    record.rowValid = false;
    this.#tmpRVec3.Set(position[0], position[1], position[2]);
    this.#tmpQuat.Set(rotation[0], rotation[1], rotation[2], rotation[3]);
    if (record.character !== null) {
      record.character.SetPosition(this.#tmpRVec3);
      record.character.SetRotation(this.#tmpQuat);
      if (teleport) {
        this.#tmpVec3.Set(0, 0, 0);
        record.character.SetLinearVelocity(this.#tmpVec3);
        record.desiredX = 0;
        record.desiredY = 0;
        record.desiredZ = 0;
      }
      return;
    }
    this.#bodies.SetPositionAndRotation(
      record.joltId,
      this.#tmpRVec3,
      this.#tmpQuat,
      this.#jolt.EActivation_Activate,
    );
    if (teleport) {
      this.#tmpVec3.Set(0, 0, 0);
      this.#tmpVec3b.Set(0, 0, 0);
      this.#bodies.SetLinearAndAngularVelocity(record.joltId, this.#tmpVec3, this.#tmpVec3b);
    }
  }

  /**
   * Overwrite both velocities.
   *
   * @param id Guest body handle.
   * @param linear Metres per second.
   * @param angular Radians per second.
   */
  setVelocity(id: number, linear: Vec3, angular: Vec3): void {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined) return;
    record.rowValid = false;
    this.#tmpVec3.Set(linear[0], linear[1], linear[2]);
    if (record.character !== null) {
      record.character.SetLinearVelocity(this.#tmpVec3);
      return;
    }
    this.#tmpVec3b.Set(angular[0], angular[1], angular[2]);
    this.#bodies.SetLinearAndAngularVelocity(record.joltId, this.#tmpVec3, this.#tmpVec3b);
  }

  /**
   * Apply an impulse. Characters ignore it: drive them with `moveCharacter`.
   *
   * @param id Guest body handle.
   * @param impulse Newton-seconds.
   * @param point World-space application point, or the centre of mass.
   */
  applyImpulse(id: number, impulse: Vec3, point?: Vec3): void {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined || record.character !== null) return;
    record.rowValid = false;
    this.#tmpVec3.Set(impulse[0], impulse[1], impulse[2]);
    if (point === undefined) {
      this.#bodies.AddImpulse(record.joltId, this.#tmpVec3);
    } else {
      this.#tmpRVec3.Set(point[0], point[1], point[2]);
      this.#bodies.AddImpulse(record.joltId, this.#tmpVec3, this.#tmpRVec3);
    }
  }

  /**
   * Take a body out of the simulation, or put it back. A disabled body keeps
   * its handle, its shape and its transform; it simply stops colliding, moving
   * and appearing in `readBodies` and in queries.
   *
   * **Characters are the exception.** A `character` body's collision shape is
   * the *inner* body a `CharacterVirtual` owns and destroys; taking it out of
   * the body manager behind the controller's back leaves the controller
   * pointing at a body that is no longer there. So disabling a character stops
   * it being stepped and stops it being read, and its inner body stays in the
   * broad phase — things still bump into a disabled character. Remove it
   * instead when it has to stop existing.
   *
   * @param id Guest body handle.
   * @param enabled Target state.
   */
  setEnabled(id: number, enabled: boolean): void {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined || record.enabled === enabled) return;
    record.enabled = enabled;
    record.rowValid = false;
    if (enabled) {
      if (record.character === null) {
        this.#bodies.AddBody(record.joltId, this.#jolt.EActivation_Activate);
      }
      if (record.kind !== 'static') insertSorted(this.#movingIds, id);
    } else {
      if (record.character === null) this.#bodies.RemoveBody(record.joltId);
      removeSorted(this.#movingIds, id);
    }
    this.#revision += 1;
  }

  /**
   * Ask a character controller to move at a velocity for the next step.
   *
   * The horizontal components are taken literally — a character has no inertia
   * of its own, which is what makes it feel like a game character rather than
   * a crate. The vertical component is a jump: a positive `y` while grounded
   * launches the character at that speed, and after that gravity integrates
   * until it lands again.
   *
   * @param id Guest body handle of a `character` body.
   * @param desiredVelocity Metres per second, world space.
   */
  moveCharacter(id: number, desiredVelocity: Vec3): void {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined || record.character === null) return;
    record.desiredX = desiredVelocity[0];
    record.desiredY = desiredVelocity[1];
    record.desiredZ = desiredVelocity[2];
  }

  /**
   * What a character is standing on, as of the last step.
   *
   * @param id Guest body handle.
   * @returns The ground state; `in-air` for anything that is not a character.
   */
  groundState(id: number): GroundState {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined || record.character === null) return 'in-air';
    const jolt = this.#jolt;
    const state = record.character.GetGroundState();
    if (state === jolt.EGroundState_OnGround) return 'on-ground';
    if (state === jolt.EGroundState_OnSteepGround) return 'on-steep-ground';
    if (state === jolt.EGroundState_NotSupported) return 'not-supported';
    return 'in-air';
  }

  // -------------------------------------------------------------------------
  // Stepping and reading
  // -------------------------------------------------------------------------

  /**
   * Advance the simulation by `dt`, then flush the contact queue for
   * `drainContacts`. Call it from `fixedUpdate` and nowhere else.
   *
   * @param dt Seconds. Keep it fixed; 1/60 is the engine default.
   * @param substeps Collision steps per call. One is right up to about 1/60 s.
   * @returns The number of contact events queued by this step.
   */
  step(dt: number, substeps = 1): number {
    this.#assertLive();
    for (const record of this.#characters) {
      if (record.enabled) this.#stepCharacter(record, dt);
    }
    this.#interface.Step(dt, substeps);
    const pending = this.#unmapAfterStep;
    if (pending.length > 0) {
      for (let i = 0; i < pending.length; i += 2) {
        // Only if the mapping still points at the body that was removed: an
        // add in the same step may have been handed the same Jolt key, and
        // that mapping belongs to the new body.
        if (this.#byJolt.get(pending[i]) === pending[i + 1]) this.#byJolt.delete(pending[i]);
      }
      pending.length = 0;
    }
    return this.#contactCount;
  }

  /**
   * Write one stride-15 row per enabled non-static body into `out`, ascending
   * by body id, exactly as the WIT `frame-input.bodies` buffer wants it:
   * `[id, px, py, pz, qx, qy, qz, qw, lvx, lvy, lvz, avx, avy, avz, groundState]`.
   *
   * Static bodies never move, so they are never written; the guest already
   * knows where it put them.
   *
   * **Grow policy.** The return value is the number of rows the world *wanted*
   * to write, which is not clamped by `out`. If `rows * 15 > out.length` only
   * the first `floor(out.length / 15)` rows landed: grow `out` to the next
   * power of two and call again. The world never allocates on your behalf, so
   * a steady-state frame does no work beyond the copy.
   * {@link PhysicsWorld.movingBodyCount} is the same number before the call, so
   * a host that sizes from it never reads twice.
   *
   * **Sleeping bodies.** Jolt puts a body that has settled to sleep, and a
   * sleeping body's row cannot have changed since the last read. Each one
   * therefore costs a single `IsActive` crossing and a 13-float copy out of the
   * record instead of fifteen crossings. The mirror is dropped whenever
   * something moves the body from outside the solver — `setTransform`,
   * `setVelocity`, `applyImpulse`, `setEnabled` — so a teleported sleeper still
   * reads true.
   *
   * @param out Destination, length a multiple of 15.
   * @returns Rows required.
   *
   * @example
   * ```ts
   * let buffer = new Float32Array(64 * 15);
   * let rows = world.readBodies(buffer);
   * if (rows * 15 > buffer.length) {
   *   buffer = new Float32Array(rows * 15);
   *   rows = world.readBodies(buffer);
   * }
   * ```
   */
  readBodies(out: Float32Array): number {
    this.#assertLive();
    const ids = this.#movingIds;
    const required = ids.length;
    const capacity = Math.floor(out.length / BODY_STRIDE);
    const rows = required < capacity ? required : capacity;
    for (let i = 0; i < rows; i += 1) {
      const base = i * BODY_STRIDE;
      const record = this.#byId.get(ids[i]);
      if (record === undefined) {
        // Cannot happen while `#movingIds` and `#byId` agree, but a stale row
        // read as a live body is far worse than a zeroed one.
        out.fill(0, base, base + BODY_STRIDE);
        continue;
      }
      out[base] = record.id;
      const row = record.row;
      const character = record.character;
      if (character !== null) {
        // A `CharacterVirtual` is integrated by hand every step, so it is never
        // asleep and there is nothing to cache.
        const p = character.GetPosition();
        const q = character.GetRotation();
        const v = character.GetLinearVelocity();
        row[0] = p.GetX();
        row[1] = p.GetY();
        row[2] = p.GetZ();
        row[3] = q.GetX();
        row[4] = q.GetY();
        row[5] = q.GetZ();
        row[6] = q.GetW();
        row[7] = v.GetX();
        row[8] = v.GetY();
        row[9] = v.GetZ();
        row[10] = 0;
        row[11] = 0;
        row[12] = 0;
        const ground = character.GetGroundState();
        row[13] =
          ground === this.#jolt.EGroundState_OnGround
            ? 1
            : ground === this.#jolt.EGroundState_OnSteepGround
              ? 2
              : ground === this.#jolt.EGroundState_NotSupported
                ? 3
                : 4;
      } else if (record.rowValid && !this.#bodies.IsActive(record.joltId)) {
        out.set(row, base + 1);
        continue;
      } else {
        this.#bodies.GetPositionAndRotation(record.joltId, this.#tmpRVec3, this.#tmpQuat);
        this.#bodies.GetLinearAndAngularVelocity(record.joltId, this.#tmpVec3, this.#tmpVec3b);
        row[0] = this.#tmpRVec3.GetX();
        row[1] = this.#tmpRVec3.GetY();
        row[2] = this.#tmpRVec3.GetZ();
        row[3] = this.#tmpQuat.GetX();
        row[4] = this.#tmpQuat.GetY();
        row[5] = this.#tmpQuat.GetZ();
        row[6] = this.#tmpQuat.GetW();
        row[7] = this.#tmpVec3.GetX();
        row[8] = this.#tmpVec3.GetY();
        row[9] = this.#tmpVec3.GetZ();
        row[10] = this.#tmpVec3b.GetX();
        row[11] = this.#tmpVec3b.GetY();
        row[12] = this.#tmpVec3b.GetZ();
        row[13] = 0;
      }
      record.rowValid = true;
      out.set(row, base + 1);
    }
    return required;
  }

  /**
   * Move queued contact events into `out` and clear the queue.
   *
   * `out` is a pool you own: entries past its current length are created for
   * you once and reused on every later call, so after the first few frames
   * this allocates nothing.
   *
   * @param out Caller-owned pool of records.
   * @returns How many entries of `out` are valid.
   *
   * @example
   * ```ts
   * const pool: ContactRecord[] = [];
   * const n = world.drainContacts(pool);
   * for (let i = 0; i < n; i += 1) console.log(pool[i].phase, pool[i].a, pool[i].b);
   * ```
   */
  drainContacts(out: ContactRecord[]): number {
    this.#assertLive();
    const count = this.#contactCount;
    while (out.length < count) out.push(createContactRecord());
    for (let i = 0; i < count; i += 1) {
      const src = this.#contactPool[i];
      const dst = out[i];
      dst.a = src.a;
      dst.b = src.b;
      dst.phase = src.phase;
      dst.px = src.px;
      dst.py = src.py;
      dst.pz = src.pz;
      dst.nx = src.nx;
      dst.ny = src.ny;
      dst.nz = src.nz;
      dst.impulse = src.impulse;
    }
    this.#contactCount = 0;
    return count;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Closest hit along a ray.
   *
   * The returned object is a single instance owned by the world and
   * overwritten by the next query — read what you need before casting again.
   *
   * @param origin Ray start, world space.
   * @param direction Ray direction; need not be normalised.
   * @param maxDistance Metres.
   * @param mask Bitset of body `layer`s the ray may hit.
   * @returns The hit, or null.
   *
   * @example
   * ```ts
   * const hit = world.raycast([0, 2, 0], [0, -1, 0], 10, 0xffff);
   * if (hit) console.log(hit.body, hit.distance);
   * ```
   */
  raycast(origin: Vec3, direction: Vec3, maxDistance: number, mask: number): RayHit | null {
    this.#assertLive();
    return this.#castRay(
      origin[0],
      origin[1],
      origin[2],
      direction[0],
      direction[1],
      direction[2],
      maxDistance,
      mask,
    )
      ? this.#hit
      : null;
  }

  /**
   * Cast many rays in one call, the shape the WIT `raycast-batch` import wants.
   *
   * @param rays Stride 7: `ox, oy, oz, dx, dy, dz, maxDistance`.
   * @param mask Bitset of body `layer`s the rays may hit.
   * @param out Stride 9: `hit, body, px, py, pz, nx, ny, nz, distance`.
   * @returns Number of rays processed, the lesser of what the two buffers hold.
   *
   * @example
   * ```ts
   * const rays = new Float32Array([0, 2, 0, 0, -1, 0, 10]);
   * const hits = new Float32Array(9);
   * world.raycastBatch(rays, 0xffff, hits);
   * if (hits[0] === 1) console.log('body', hits[1], 'at', hits[8]);
   * ```
   */
  raycastBatch(rays: Float32Array, mask: number, out: Float32Array): number {
    this.#assertLive();
    const count = Math.min(
      Math.floor(rays.length / RAY_STRIDE),
      Math.floor(out.length / RAY_HIT_STRIDE),
    );
    for (let i = 0; i < count; i += 1) {
      const r = i * RAY_STRIDE;
      const o = i * RAY_HIT_STRIDE;
      const found = this.#castRay(
        rays[r],
        rays[r + 1],
        rays[r + 2],
        rays[r + 3],
        rays[r + 4],
        rays[r + 5],
        rays[r + 6],
        mask,
      );
      if (!found) {
        out.fill(0, o, o + RAY_HIT_STRIDE);
        continue;
      }
      const hit = this.#hit;
      out[o] = 1;
      out[o + 1] = hit.body;
      out[o + 2] = hit.px;
      out[o + 3] = hit.py;
      out[o + 4] = hit.pz;
      out[o + 5] = hit.nx;
      out[o + 6] = hit.ny;
      out[o + 7] = hit.nz;
      out[o + 8] = hit.distance;
    }
    return count;
  }

  /**
   * Guest body ids overlapping a sphere, nearest first.
   *
   * This allocates the result array, so it belongs in spawn and interaction
   * code, not in a system that runs every step. Use
   * {@link PhysicsWorld.overlapSphereInto} there.
   *
   * @param center Sphere centre, world space.
   * @param radius Metres.
   * @param mask Bitset of body `layer`s to consider.
   * @returns Body ids, nearest first.
   *
   * @example
   * ```ts
   * for (const id of world.overlapSphere([0, 1, 0], 3, 0xffff)) console.log(id);
   * ```
   */
  overlapSphere(center: Vec3, radius: number, mask: number): number[] {
    const found = this.overlapSphereInto(center, radius, mask, EMPTY_IDS);
    const out = new Array<number>(found);
    for (let i = 0; i < found; i += 1) out[i] = this.#overlapIds[i];
    return out;
  }

  /**
   * {@link PhysicsWorld.overlapSphere} without the allocation.
   *
   * @param center Sphere centre, world space.
   * @param radius Metres.
   * @param mask Bitset of body `layer`s to consider.
   * @param out Destination for body ids, nearest first.
   * @returns The number of overlapping bodies found, which may exceed
   *   `out.length`; only the first `out.length` were written.
   *
   * @example
   * ```ts
   * const ids = new Uint32Array(16);
   * const n = world.overlapSphereInto([0, 1, 0], 3, 0xffff, ids);
   * ```
   */
  overlapSphereInto(center: Vec3, radius: number, mask: number, out: Uint32Array): number {
    this.#assertLive();
    const broadPhase = this.#prepareQuery(mask);
    if (broadPhase === null) return 0;
    this.#overlapCollector.Reset();
    this.#tmpRVec3.Set(center[0], center[1], center[2]);
    const transform = this.#jolt.RMat44.prototype.sTranslation(this.#tmpRVec3);
    this.#tmpVec3.Set(radius, radius, radius);
    this.#system
      .GetNarrowPhaseQuery()
      .CollideShape(
        this.#overlapShape,
        this.#tmpVec3,
        transform,
        this.#overlapSettings,
        this.#zeroOffset,
        this.#overlapCollector,
        broadPhase,
        this.#objectLayerFilter,
        this.#bodyFilter,
        this.#shapeFilter,
      );

    const hits = this.#overlapCollector.mHits;
    const hitCount = hits.size();
    if (this.#overlapIds.length < hitCount) {
      this.#overlapIds = new Uint32Array(atLeast(hitCount));
      this.#overlapDist = new Float64Array(this.#overlapIds.length);
    }
    // One epoch per query: a stamp that matches means "already collected", so
    // nothing has to be cleared between calls and the dedupe stays O(1) rather
    // than scanning what has been found so far.
    this.#overlapEpoch += 1;
    const epoch = this.#overlapEpoch;
    let seen = this.#overlapSeen;
    let previousId = 0;
    let found = 0;
    for (let i = 0; i < hitCount; i += 1) {
      const hit = hits.at(i);
      const id = this.#byJolt.get(hit.mBodyID2.GetIndexAndSequenceNumber());
      if (id === undefined) continue;
      // A mesh collider reports one hit per triangle, so the same body arrives
      // many times in a row: the common case never touches the stamp table.
      if (id === previousId) continue;
      previousId = id;
      if (id < seen.length) {
        if (seen[id] === epoch) continue;
        seen[id] = epoch;
      } else {
        const grown = new Uint32Array(atLeast(id + 1));
        grown.set(seen);
        this.#overlapSeen = grown;
        seen = grown;
        seen[id] = epoch;
      }
      const p = hit.mContactPointOn2;
      const dx = p.GetX() - center[0];
      const dy = p.GetY() - center[1];
      const dz = p.GetZ() - center[2];
      this.#overlapIds[found] = id;
      this.#overlapDist[found] = dx * dx + dy * dy + dz * dz;
      found += 1;
    }

    // Insertion sort by distance. `found` is a handful of bodies in practice.
    for (let i = 1; i < found; i += 1) {
      const id = this.#overlapIds[i];
      const d = this.#overlapDist[i];
      let j = i - 1;
      while (j >= 0 && this.#overlapDist[j] > d) {
        this.#overlapIds[j + 1] = this.#overlapIds[j];
        this.#overlapDist[j + 1] = this.#overlapDist[j];
        j -= 1;
      }
      this.#overlapIds[j + 1] = id;
      this.#overlapDist[j + 1] = d;
    }
    const written = Math.min(found, out.length);
    for (let i = 0; i < written; i += 1) out[i] = this.#overlapIds[i];
    return found;
  }

  // -------------------------------------------------------------------------
  // Introspection and teardown
  // -------------------------------------------------------------------------

  /**
   * How many bodies the world currently holds.
   *
   * @returns The live body count.
   */
  get bodyCount(): number {
    return this.#allIds.length;
  }

  /**
   * How many rows the next {@link PhysicsWorld.readBodies} will fill: the
   * enabled, non-static bodies. A host sizes its destination from this and
   * never reads twice.
   *
   * @returns The moving body count.
   */
  get movingBodyCount(): number {
    return this.#movingIds.length;
  }

  /**
   * Bumped on every add, remove, enable and disable.
   *
   * @returns The structural revision counter.
   */
  get revision(): number {
    return this.#revision;
  }

  /**
   * Every live body id, ascending. The array is the world's own; treat it as
   * read-only and do not hold it across a structural change.
   *
   * @returns Live body ids.
   */
  bodyIds(): readonly number[] {
    return this.#allIds;
  }

  /**
   * Local-space shape bounds plus world transform, for debug drawing.
   *
   * Writes 13 floats at `offset`: `minX, minY, minZ, maxX, maxY, maxZ,
   * px, py, pz, qx, qy, qz, qw`.
   *
   * @param id Guest body handle.
   * @param out Destination, at least `offset + 13` long.
   * @param offset Where to start writing.
   * @returns False when the body is unknown or `out` is too small.
   */
  readBodyBounds(id: number, out: Float32Array, offset: number): boolean {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined || out.length < offset + 13) return false;
    const bounds = record.shape.GetLocalBounds();
    const min = bounds.mMin;
    const max = bounds.mMax;
    out[offset] = min.GetX();
    out[offset + 1] = min.GetY();
    out[offset + 2] = min.GetZ();
    out[offset + 3] = max.GetX();
    out[offset + 4] = max.GetY();
    out[offset + 5] = max.GetZ();
    return this.readBodyPose(id, out, offset + 6);
  }

  /**
   * The world transform of one body: `px, py, pz, qx, qy, qz, qw`.
   *
   * The pose half of {@link PhysicsWorld.readBodyBounds}. A body's *local*
   * bounds cannot change — the shape is immutable — so a debug view reads the
   * bounds once when the body set changes and only the pose thereafter, which
   * is half as many wasm crossings per body per frame.
   *
   * @param id Guest body handle.
   * @param out Destination, at least `offset + 7` long.
   * @param offset Where to start writing.
   * @returns False when the body is unknown or `out` is too small.
   *
   * @example
   * ```ts
   * const pose = new Float32Array(7);
   * if (world.readBodyPose(1, pose, 0)) console.log(pose[1]); // y
   * ```
   */
  readBodyPose(id: number, out: Float32Array, offset: number): boolean {
    this.#assertLive();
    const record = this.#byId.get(id);
    if (record === undefined || out.length < offset + 7) return false;
    if (record.character !== null) {
      const p = record.character.GetPosition();
      const q = record.character.GetRotation();
      out[offset] = p.GetX();
      out[offset + 1] = p.GetY();
      out[offset + 2] = p.GetZ();
      out[offset + 3] = q.GetX();
      out[offset + 4] = q.GetY();
      out[offset + 5] = q.GetZ();
      out[offset + 6] = q.GetW();
      return true;
    }
    this.#bodies.GetPositionAndRotation(record.joltId, this.#tmpRVec3, this.#tmpQuat);
    out[offset] = this.#tmpRVec3.GetX();
    out[offset + 1] = this.#tmpRVec3.GetY();
    out[offset + 2] = this.#tmpRVec3.GetZ();
    out[offset + 3] = this.#tmpQuat.GetX();
    out[offset + 4] = this.#tmpQuat.GetY();
    out[offset + 5] = this.#tmpQuat.GetZ();
    out[offset + 6] = this.#tmpQuat.GetW();
    return true;
  }

  /**
   * Free every Jolt object this world owns.
   *
   * Jolt is a C++ library behind emscripten: **nothing** is garbage collected.
   * Every `new jolt.X` needs a matching `jolt.destroy`, every reference-counted
   * object an `AddRef`/`Release` pair. This method is the one place that has to
   * get it right, and the order matters: bodies and characters first (they
   * hold shape references), then the scratch objects, then the
   * `JoltInterface`, and only then the layer filters the interface was
   * borrowing. Calling it twice is a no-op.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const jolt = this.#jolt;

    // Before anything else: the listener is about to be freed, and removing a
    // body fires `OnContactRemoved`.
    this.#system.SetContactListener(null as unknown as JoltInstance<'ContactListener'>);

    for (const id of [...this.#allIds]) {
      const record = this.#byId.get(id);
      if (record === undefined) continue;
      if (record.character !== null) {
        // Destroying the controller destroys its inner body with it.
        jolt.destroy(record.character);
        record.character = null;
      } else {
        if (record.enabled) this.#bodies.RemoveBody(record.joltId);
        this.#bodies.DestroyBody(record.joltId);
      }
      record.shape.Release();
      jolt.destroy(record.joltId);
    }
    this.#byId.clear();
    this.#byJolt.clear();
    this.#allIds.length = 0;
    this.#movingIds.length = 0;
    this.#characters.length = 0;
    this.#unmapAfterStep.length = 0;
    this.#contactCount = 0;
    this.#reportingBodies = 0;
    this.#stayBodies = 0;

    jolt.destroy(this.#contactListener);
    jolt.destroy(this.#extendedUpdate);
    jolt.destroy(this.#objectLayerFilter);
    jolt.destroy(this.#shapeFilter);
    jolt.destroy(this.#bodyFilter);
    jolt.destroy(this.#broadPhaseMoving);
    jolt.destroy(this.#broadPhaseStatic);
    jolt.destroy(this.#broadPhaseFilter);
    jolt.destroy(this.#overlapCollector);
    jolt.destroy(this.#overlapSettings);
    this.#overlapShape.Release();
    jolt.destroy(this.#rayCollector);
    jolt.destroy(this.#raySettings);
    jolt.destroy(this.#ray);
    jolt.destroy(this.#zeroOffset);
    jolt.destroy(this.#tmpQuat);
    jolt.destroy(this.#tmpRVec3b);
    jolt.destroy(this.#tmpRVec3);
    jolt.destroy(this.#tmpVec3b);
    jolt.destroy(this.#tmpVec3);
    jolt.destroy(this.#gravityVec);

    jolt.destroy(this.#interface);
    this.#layers.dispose();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Throw if the world has been disposed.
   */
  #assertLive(): void {
    if (this.#disposed) throw new Error('this PhysicsWorld has been disposed');
  }

  /**
   * Build (or borrow) the Jolt shape for a body.
   *
   * @param args Body description.
   * @returns A shape whose reference the caller must take.
   */
  #buildShape(args: BodyArgs): JoltShape {
    const jolt = this.#jolt;
    const d = args.dims;
    switch (args.shape) {
      case 'box': {
        const hx = dim(d, 0);
        const hy = dim(d, 1);
        const hz = dim(d, 2);
        const half = new jolt.Vec3(hx, hy, hz);
        const shape = new jolt.BoxShape(half, convexRadius(Math.min(hx, hy, hz)));
        jolt.destroy(half);
        return shape;
      }
      case 'sphere':
        return new jolt.SphereShape(dim(d, 0));
      case 'capsule':
        return new jolt.CapsuleShape(dim(d, 1), dim(d, 0));
      case 'cylinder': {
        const radius = dim(d, 0);
        const halfHeight = dim(d, 1);
        return new jolt.CylinderShape(
          halfHeight,
          radius,
          convexRadius(Math.min(radius, halfHeight)),
        );
      }
      case 'mesh':
      case 'convex': {
        if (args.geometry === undefined) {
          throw new Error(
            `body ${String(args.id)} is a '${args.shape}' shape but has no geometry; ` +
              `build one with meshShapeFromGeometry() or convexHullFromPoints()`,
          );
        }
        return args.geometry;
      }
    }
  }

  /**
   * Create the rigid body half of `addBody`.
   *
   * @param record Record to fill in.
   * @param args Body description.
   * @param shape Shape to use.
   * @param slot Jolt object layer.
   * @param flags Body switches.
   */
  #createRigidBody(
    record: BodyRecord,
    args: BodyArgs,
    shape: JoltShape,
    slot: number,
    flags: BodyFlags,
  ): void {
    const jolt = this.#jolt;
    const motion =
      args.kind === 'static'
        ? jolt.EMotionType_Static
        : args.kind === 'kinematic'
          ? jolt.EMotionType_Kinematic
          : jolt.EMotionType_Dynamic;

    this.#tmpRVec3.Set(args.position[0], args.position[1], args.position[2]);
    this.#tmpQuat.Set(args.rotation[0], args.rotation[1], args.rotation[2], args.rotation[3]);
    const settings = new jolt.BodyCreationSettings(
      shape,
      this.#tmpRVec3,
      this.#tmpQuat,
      motion,
      slot,
    );
    settings.mFriction = args.friction;
    settings.mRestitution = args.restitution;
    settings.mLinearDamping = args.linearDamping ?? 0.05;
    settings.mAngularDamping = args.angularDamping ?? 0.05;
    if (flags.sensor === true) settings.mIsSensor = true;
    if (flags.noSleep === true) settings.mAllowSleeping = false;
    if (flags.ccd === true) settings.mMotionQuality = jolt.EMotionQuality_LinearCast;
    if (flags.lockRotation === true) {
      settings.mAllowedDOFs =
        jolt.EAllowedDOFs_TranslationX |
        jolt.EAllowedDOFs_TranslationY |
        jolt.EAllowedDOFs_TranslationZ;
    }
    if (args.kind === 'dynamic' && args.mass > 0) {
      settings.mOverrideMassProperties = jolt.EOverrideMassProperties_CalculateInertia;
      settings.mMassPropertiesOverride.mMass = args.mass;
    }

    const activation =
      args.kind === 'static' ? jolt.EActivation_DontActivate : jolt.EActivation_Activate;
    // `CreateAndAddBody` hands back a temporary. Copy the number out of it, and
    // evict its wrapper: the address is Jolt's scratch and will be a different
    // body's next time, so an interned wrapper here is a per-spawn leak.
    const created = this.#bodies.CreateAndAddBody(settings, activation);
    const key = created.GetIndexAndSequenceNumber();
    this.#evict(created);
    jolt.destroy(settings);

    // `BodyID` has no setter, so the placeholder the record was built with is
    // replaced — and has to be freed, or every spawn leaks one.
    jolt.destroy(record.joltId);
    record.joltId = new jolt.BodyID(key);
    record.joltKey = key;
  }

  /**
   * Create the `CharacterVirtual` half of `addBody`.
   *
   * The controller is not a body, so it gets an *inner* kinematic body built
   * from the same shape. That body is what other bodies collide with, what
   * raycasts hit, and what contact events name — which is why one guest id can
   * address both halves.
   *
   * @param record Record to fill in.
   * @param args Body description.
   * @param shape Shape to use.
   * @param slot Jolt object layer.
   */
  #createCharacter(record: BodyRecord, args: BodyArgs, shape: JoltShape, slot: number): void {
    const jolt = this.#jolt;
    const settings = new jolt.CharacterVirtualSettings();
    settings.mShape = shape;
    settings.mMaxSlopeAngle = MAX_SLOPE_DEG * DEG2RAD;
    settings.mMass = args.mass > 0 ? args.mass : 70;
    settings.mInnerBodyShape = shape;
    settings.mInnerBodyLayer = slot;
    // Only contacts under the shape's own lower hemisphere count as ground.
    //
    // A Jolt plane is `dot(normal, x) + constant = 0` and everything *behind*
    // it may support the character, so the constant is the negated height of
    // the cut. Putting the cut at the top of the bottom sphere — the shape's
    // lowest point plus its inner radius, which is `-halfHeight` for a capsule
    // — means a wall the character brushes cannot count as floor. The old
    // `+1.05 * radius` put the cut *above* the centre, so a capsule pressed
    // against a pillar reported itself grounded in mid-air.
    const bounds = shape.GetLocalBounds();
    const cut = bounds.mMin.GetY() + shape.GetInnerRadius();
    const up = new jolt.Vec3(0, 1, 0);
    const supporting = new jolt.Plane(up, -cut);
    settings.mSupportingVolume = supporting;
    jolt.destroy(up);

    this.#tmpRVec3.Set(args.position[0], args.position[1], args.position[2]);
    this.#tmpQuat.Set(args.rotation[0], args.rotation[1], args.rotation[2], args.rotation[3]);
    const character = new jolt.CharacterVirtual(
      settings,
      this.#tmpRVec3,
      this.#tmpQuat,
      this.#system,
    );
    jolt.destroy(supporting);
    jolt.destroy(settings);

    const innerId = character.GetInnerBodyID();
    const key = innerId.GetIndexAndSequenceNumber();
    this.#evict(innerId);
    record.character = character;
    jolt.destroy(record.joltId);
    record.joltId = new jolt.BodyID(key);
    record.joltKey = key;
    this.#bodies.SetFriction(record.joltId, args.friction);
    this.#bodies.SetRestitution(record.joltId, args.restitution);
  }

  /**
   * Integrate gravity and run one `ExtendedUpdate` for a character.
   *
   * @param record The character record.
   * @param dt Seconds.
   */
  #stepCharacter(record: BodyRecord, dt: number): void {
    const character = record.character;
    if (character === null) return;
    const grounded = character.GetGroundState() === this.#jolt.EGroundState_OnGround;
    let vy = character.GetLinearVelocity().GetY();
    if (grounded) {
      vy = record.desiredY > 0 ? record.desiredY : 0;
      // A jump is an edge, not a state: consuming it here is what stops one
      // `moveCharacter([0, 5, 0])` from re-launching the character every time
      // it lands, for as long as nobody overwrites the desired velocity.
      record.desiredY = 0;
    } else {
      vy += this.#gravity[1] * dt;
    }
    this.#tmpVec3.Set(record.desiredX, vy, record.desiredZ);
    character.SetLinearVelocity(this.#tmpVec3);

    const broadPhase = this.#prepareQuery(record.mask) ?? this.#broadPhaseFilter;
    character.ExtendedUpdate(
      dt,
      this.#gravityVec,
      this.#extendedUpdate,
      broadPhase,
      this.#objectLayerFilter,
      this.#bodyFilter,
      this.#shapeFilter,
      this.#tempAllocator,
    );
  }

  /**
   * Core raycast, shared by `raycast` and `raycastBatch`.
   *
   * @param ox Ray origin x.
   * @param oy Ray origin y.
   * @param oz Ray origin z.
   * @param dx Direction x.
   * @param dy Direction y.
   * @param dz Direction z.
   * @param maxDistance Metres.
   * @param mask Layer bitset.
   * @returns True when `this.#hit` was filled in.
   */
  #castRay(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    mask: number,
  ): boolean {
    // `Math.hypot` is variadic and overflow-safe, which costs about an order of
    // magnitude over the arithmetic; a ray direction in metres cannot overflow.
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length === 0 || maxDistance <= 0) return false;
    const scale = maxDistance / length;

    const broadPhase = this.#prepareQuery(mask);
    if (broadPhase === null) return false;
    this.#tmpRVec3.Set(ox, oy, oz);
    this.#tmpVec3.Set(dx * scale, dy * scale, dz * scale);
    this.#ray.mOrigin = this.#tmpRVec3;
    this.#ray.mDirection = this.#tmpVec3;
    this.#rayCollector.Reset();
    this.#system
      .GetNarrowPhaseQuery()
      .CastRay(
        this.#ray,
        this.#raySettings,
        this.#rayCollector,
        broadPhase,
        this.#objectLayerFilter,
        this.#bodyFilter,
        this.#shapeFilter,
      );
    if (!this.#rayCollector.HadHit()) return false;

    const result = this.#rayCollector.mHit;
    const id = this.#byJolt.get(result.mBodyID.GetIndexAndSequenceNumber());
    if (id === undefined) return false;

    const fraction = result.mFraction;
    const point = this.#ray.GetPointOnRay(fraction);
    const px = point.GetX();
    const py = point.GetY();
    const pz = point.GetZ();
    this.#tmpRVec3b.Set(px, py, pz);
    // `TryGetBody` is allowed to fail — the id is a moment old and the body may
    // have been removed since — and it answers with a null pointer, which the
    // binder happily wraps in a JS object that traps the moment it is used.
    const body = this.#lock.TryGetBody(result.mBodyID);
    if (this.#binder.getPointer(body) === 0) return false;
    const normal = body.GetWorldSpaceSurfaceNormal(result.mSubShapeID2, this.#tmpRVec3b);

    const hit = this.#hit;
    hit.body = id;
    hit.px = px;
    hit.py = py;
    hit.pz = pz;
    hit.nx = normal.GetX();
    hit.ny = normal.GetY();
    hit.nz = normal.GetZ();
    hit.distance = fraction * maxDistance;
    return true;
  }

  /**
   * Wire up the four `ContactListenerJS` callbacks.
   *
   * These run inside `Step()`, once per contact pair per step, so the first
   * thing each one does is ask whether anybody wants the answer. With no body
   * reporting contacts a world of resting crates never wraps a pointer, never
   * touches a map and never allocates: the whole subsystem costs one integer
   * comparison per callback.
   */
  #installContactListener(): void {
    const jolt = this.#jolt;
    const listener = this.#contactListener;

    listener.OnContactValidate = (): number => jolt.ValidateResult_AcceptAllContactsForThisBodyPair;

    listener.OnContactAdded = (body1: number, body2: number, manifold: number): void => {
      if (this.#reportingBodies === 0) return;
      this.#recordManifold(body1, body2, manifold, 'begin');
    };
    listener.OnContactPersisted = (body1: number, body2: number, manifold: number): void => {
      if (this.#stayBodies === 0) return;
      this.#recordManifold(body1, body2, manifold, 'stay');
    };
    listener.OnContactRemoved = (pairPointer: number): void => {
      if (this.#reportingBodies === 0) return;
      const pair = jolt.wrapPointer(pairPointer, jolt.SubShapeIDPair);
      const id1 = pair.GetBody1ID();
      const id2 = pair.GetBody2ID();
      const a = this.#byJolt.get(id1.GetIndexAndSequenceNumber());
      const b = this.#byJolt.get(id2.GetIndexAndSequenceNumber());
      // A `SubShapeIDPair` is a temporary: its address, and the addresses of
      // the two `BodyID`s inside it, differ from one removal to the next, so
      // every wrapper interned here would live for the rest of the session.
      this.#evict(id1);
      this.#evict(id2);
      this.#evict(pair);
      if (a === undefined || b === undefined) return;
      if (!this.#shouldReport(a, b, false)) return;
      const record = this.#nextContact();
      if (record === null) return;
      record.a = a;
      record.b = b;
      record.phase = 'end';
      record.px = 0;
      record.py = 0;
      record.pz = 0;
      record.nx = 0;
      record.ny = 0;
      record.nz = 0;
      record.impulse = 0;
    };
  }

  /**
   * Turn one Jolt manifold callback into a queued {@link ContactRecord}.
   *
   * @param body1 Pointer to the first body.
   * @param body2 Pointer to the second body.
   * @param manifold Pointer to the contact manifold.
   * @param phase Begin or stay.
   */
  #recordManifold(body1: number, body2: number, manifold: number, phase: ContactPhase): void {
    const jolt = this.#jolt;
    // `Body` wrappers are interned per body address and there is a fixed,
    // small number of those, so these two are a genuine cache hit after the
    // first step and are deliberately not evicted.
    const b1 = jolt.wrapPointer(body1, jolt.Body);
    const b2 = jolt.wrapPointer(body2, jolt.Body);
    const a = this.#byJolt.get(b1.GetID().GetIndexAndSequenceNumber());
    const b = this.#byJolt.get(b2.GetID().GetIndexAndSequenceNumber());
    if (a === undefined || b === undefined) return;
    // Before the manifold is wrapped: a pair nobody asked about costs nothing
    // beyond the two map lookups above.
    if (!this.#shouldReport(a, b, phase === 'stay')) return;
    const record = this.#nextContact();
    if (record === null) return;

    const m = jolt.wrapPointer(manifold, jolt.ContactManifold);
    const normal = m.mWorldSpaceNormal;
    const nx = normal.GetX();
    const ny = normal.GetY();
    const nz = normal.GetZ();
    // A speculative contact can carry an empty point list, and Jolt indexes
    // that list without checking.
    const hasPoint = m.mRelativeContactPointsOn1.size() > 0;
    const point = hasPoint ? m.GetWorldSpaceContactPointOn1(0) : null;
    const px = point === null ? 0 : point.GetX();
    const py = point === null ? 0 : point.GetY();
    const pz = point === null ? 0 : point.GetZ();
    this.#evict(m);

    const inv1 =
      b1.GetMotionType() === jolt.EMotionType_Dynamic
        ? b1.GetMotionProperties().GetInverseMass()
        : 0;
    const inv2 =
      b2.GetMotionType() === jolt.EMotionType_Dynamic
        ? b2.GetMotionProperties().GetInverseMass()
        : 0;
    const v1 = b1.GetLinearVelocity();
    const v2 = b2.GetLinearVelocity();
    const closing =
      (v1.GetX() - v2.GetX()) * nx + (v1.GetY() - v2.GetY()) * ny + (v1.GetZ() - v2.GetZ()) * nz;
    const invSum = inv1 + inv2;
    const impulse = invSum > 0 ? Math.abs(closing) / invSum : 0;

    record.a = a;
    record.b = b;
    record.phase = phase;
    record.px = px;
    record.py = py;
    record.pz = pz;
    record.nx = nx;
    record.ny = ny;
    record.nz = nz;
    record.impulse = impulse;
  }

  /**
   * Whether either body asked for this phase to be reported.
   *
   * One flagged side is enough: a projectile that wants to know what it hit
   * should not need every wall in the level to agree.
   *
   * @param a First guest body id.
   * @param b Second guest body id.
   * @param stay True for the `stay` phase, which needs the stricter flag.
   * @returns True when the pair should be queued.
   */
  #shouldReport(a: number, b: number, stay: boolean): boolean {
    const ra = this.#byId.get(a);
    const rb = this.#byId.get(b);
    if (stay) return (ra?.reportStay ?? false) || (rb?.reportStay ?? false);
    return (ra?.reportContacts ?? false) || (rb?.reportContacts ?? false);
  }

  /**
   * Take the next record off the contact pool.
   *
   * The pool is a fixed `maxContactsPerStep` allocated in the constructor,
   * because this runs inside `Step()` and growing an array there is exactly the
   * per-frame allocation the engine forbids. A step that overflows it drops the
   * surplus and says so once.
   *
   * @returns A record to overwrite, or null when this step is full.
   */
  #nextContact(): ContactRecord | null {
    if (this.#contactCount === this.#contactPool.length) {
      if (!this.#warnedOverflow) {
        this.#warnedOverflow = true;
        console.warn(
          `[physics] more than ${String(this.#contactPool.length)} reportable contacts in one ` +
            `step; the rest are dropped. Raise maxContactsPerStep, or give reportContacts to ` +
            `fewer bodies.`,
        );
      }
      return null;
    }
    const record = this.#contactPool[this.#contactCount];
    this.#contactCount += 1;
    return record;
  }

  /**
   * Drop one interned wrapper, so the binder's cache cannot grow without bound.
   *
   * Safe only for a wrapper nothing retains past the call that made it; see
   * {@link BinderApi}.
   *
   * @param wrapper A wrapper from `wrapPointer`.
   */
  #evict(wrapper: object): void {
    const binder = this.#binder;
    // `Reflect.deleteProperty` rather than `delete`, because the key is a
    // pointer: it has to leave the object, not merely become undefined, or the
    // cache still grows one key per contact.
    Reflect.deleteProperty(binder.getCache(binder.getClass(wrapper)), binder.getPointer(wrapper));
  }

  /**
   * Point the shared query filters at a mask, and pick the narrowest
   * broad-phase filter that can still answer.
   *
   * Jolt's JS bindings expose no scriptable broad-phase filter, only the
   * accept-everything one and `SpecifiedBroadPhaseLayerFilter`, which visits a
   * single tree. That is enough: the static and moving trees hold disjoint
   * slot ranges, so a mask that matches no static body's layer bits can skip
   * the static tree outright — which is what a hitscan against
   * `staticGeometry` and a camera probe both want.
   *
   * @param mask Bitset of body `layer`s the query may hit.
   * @returns The broad-phase filter to pass, or null when nothing can match.
   */
  #prepareQuery(mask: number): JoltInstance<'BroadPhaseLayerFilter'> | null {
    const bits = mask >>> 0;
    const layers = this.#layers;
    // The accept table only has to be rebuilt when the question changes: the
    // mask, or the set of slots that exist.
    if (this.#acceptMask !== bits || this.#acceptRevision !== layers.revision) {
      layers.fillAccept(bits, this.#acceptSlots);
      this.#acceptMask = bits;
      this.#acceptRevision = layers.revision;
    }
    const wantsStatic = (layers.staticLayerBits & bits) !== 0;
    const wantsMoving = (layers.movingLayerBits & bits) !== 0;
    if (wantsStatic && wantsMoving) return this.#broadPhaseFilter;
    if (wantsStatic) return this.#broadPhaseStatic;
    if (wantsMoving) return this.#broadPhaseMoving;
    return null;
  }
}

/**
 * Read a shape dimension, defaulting missing entries to a sane positive value.
 *
 * @param dims The `dims` array.
 * @param index Which entry.
 * @returns The dimension in metres.
 */
function dim(dims: readonly number[], index: number): number {
  const value = dims.length > index ? dims[index] : undefined;
  return value === undefined || !Number.isFinite(value) ? 0.5 : value;
}

/**
 * Insert into a sorted ascending array of unique numbers.
 *
 * @param array Sorted array, mutated in place.
 * @param value Value to insert.
 */
function insertSorted(array: number[], value: number): void {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (array[mid] < value) low = mid + 1;
    else high = mid;
  }
  array.splice(low, 0, value);
}

/**
 * Remove from a sorted ascending array of unique numbers.
 *
 * @param array Sorted array, mutated in place.
 * @param value Value to remove.
 */
function removeSorted(array: number[], value: number): void {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (array[mid] < value) low = mid + 1;
    else high = mid;
  }
  if (low < array.length && array[low] === value) array.splice(low, 1);
}

/**
 * A capacity of at least `n`: the next power of two, never below 16.
 *
 * Not `nextPowerOfTwo`, which it never was — `nextPowerOfTwo(4)` is 16 here,
 * and the floor is the point.
 *
 * @param n Wanted capacity.
 * @returns The capacity to allocate.
 */
function atLeast(n: number): number {
  let size = 16;
  while (size < n) size *= 2;
  return size;
}
