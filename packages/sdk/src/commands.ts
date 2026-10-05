/**
 * The per-frame command list, and the object pool that keeps it free of
 * allocation.
 *
 * `frame-output.commands` is a list of tagged variants. Building it naively
 * would allocate one wrapper, one payload and several `Vec3`s per command,
 * every frame. Instead every tag owns a pool of fully shaped `{ tag, val }`
 * slots that are handed out in order and mutated in place; `reset()` rewinds
 * the cursors without freeing anything.
 *
 * Two details matter inside QuickJS, where closures and `Map` iterators cost
 * far more than they do in V8:
 *
 * - every payload factory is a module const, so a call site passes a reference
 *   instead of building a closure;
 * - pools are a plain array indexed by `TAG_ORDINAL[tag]`, so `reset()` is one
 *   `Int32Array.fill` and taking a slot is two index reads.
 */
import type {
  AddBodyCmd,
  ApplyImpulseCmd,
  AudioBus,
  BodyFlags,
  BodyId,
  BodyKind,
  CollisionLayers,
  Command,
  CommandTag,
  ConversationCmd,
  Entity,
  ExpressionSpace,
  LoadAssetCmd,
  LookAtCmd,
  MaterialValue,
  MoveCharacterCmd,
  PlaySoundCmd,
  Quat,
  SayCmd,
  SetAnimCmd,
  SetAssetCmd,
  SetBodyEnabledCmd,
  SetBodyTransformCmd,
  SetBodyVelocityCmd,
  SetCharacterStateCmd,
  SetClipWeightsCmd,
  SetExpressionCmd,
  SetListenerCmd,
  SetMaterialParamCmd,
  SetParentCmd,
  ShapeKind,
  SoundId,
  SpawnCharacterCmd,
  SpawnCmd,
  StopSoundCmd,
  Vec3,
} from './types';

/**
 * Round to f32.
 *
 * Every float in the WIT contract is an `f32`. The wasm boundary rounds on the
 * way out; direct mode would otherwise hand the engine full `f64` precision
 * and the two modes would drift apart. One `Math.fround` per assignment keeps
 * them bit-identical, and it is a single machine instruction.
 *
 * Writing into a `Float32Array` rounds the same way, which is why the two
 * `list<f32>` payloads are copied into pooled typed arrays instead.
 */
const f = Math.fround;

/** `Math.fround(0.5)`, the default body friction. Rounded once, not per call. */
const F32_HALF = f(0.5);

/** `Math.fround(0.05)`, the default linear and angular damping. */
const F32_DAMPING = f(0.05);

/**
 * Fresh zero vector.
 *
 * @returns A mutable `Vec3` at the origin.
 */
const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });

/**
 * Fresh identity rotation.
 *
 * @returns A mutable `Quat`.
 */
const q4 = (): Quat => ({ x: 0, y: 0, z: 0, w: 1 });

/**
 * Every command tag mapped to its pool index.
 *
 * Written out rather than derived so the compiler checks it: `Record` over the
 * `CommandTag` union rejects both a missing tag and one that is not in the WIT
 * variant. `packages/wasm-host/src/apply.test.ts` pins the same list from the
 * host side.
 *
 * @example
 * ```ts
 * import { TAG_ORDINAL } from 'gameable';
 *
 * console.log(TAG_ORDINAL['set-time-scale']); // 24
 * ```
 */
export const TAG_ORDINAL: Record<CommandTag, number> = {
  spawn: 0,
  despawn: 1,
  'set-asset': 2,
  'set-parent': 3,
  'set-anim': 4,
  'set-material-param': 5,
  'add-body': 6,
  'remove-body': 7,
  'set-body-transform': 8,
  'set-body-velocity': 9,
  'apply-impulse': 10,
  'set-body-enabled': 11,
  'move-character': 12,
  'spawn-character': 13,
  'set-character-state': 14,
  'set-clip-weights': 15,
  'set-expression': 16,
  'look-at': 17,
  say: 18,
  'play-sound': 19,
  'stop-sound': 20,
  'set-listener': 21,
  'load-asset': 22,
  'set-pointer-lock': 23,
  'set-time-scale': 24,
  conversation: 25,
  send: 26,
  'set-player-camera': 27,
  'set-player-hud': 28,
  'save-player-data': 29,
  'save-game-data': 30,
  exchange: 31,
  'set-player-entity': 32,
};

/** How many pools a `CommandBuffer` holds. Computed once, at module scope. */
const TAG_COUNT = Object.keys(TAG_ORDINAL).length;

/** The weights a freshly minted clip/expression slot starts with. */
const EMPTY_WEIGHTS = new Float32Array(0);

/**
 * Build a `spawn` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSpawn = (): SpawnCmd => ({
  entity: 0,
  asset: undefined,
  position: v3(),
  rotation: q4(),
  scale: { x: 1, y: 1, z: 1 },
  parent: undefined,
  visible: true,
  name: undefined,
});

/**
 * Build a `set-asset` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetAsset = (): SetAssetCmd => ({ entity: 0, asset: undefined });

/**
 * Build a `set-parent` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetParent = (): SetParentCmd => ({
  entity: 0,
  parent: undefined,
  keepWorldTransform: false,
});

/**
 * Build a `set-anim` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetAnim = (): SetAnimCmd => ({
  entity: 0,
  clip: '',
  looping: false,
  speed: 1,
  fadeMs: 0,
  weight: 1,
});

/**
 * Build a `set-material-param` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetMaterialParam = (): SetMaterialParamCmd => ({
  entity: 0,
  name: '',
  value: { tag: 'scalar', val: 0 },
});

/**
 * Build an `add-body` payload.
 *
 * @returns A fully shaped payload carrying the rounded defaults.
 */
const makeAddBody = (): AddBodyCmd => ({
  body: 0,
  entity: 0,
  kind: 'dynamic',
  shape: { kind: 'box', halfExtents: v3(), asset: undefined },
  position: v3(),
  rotation: q4(),
  mass: 1,
  friction: F32_HALF,
  restitution: 0,
  linearDamping: F32_DAMPING,
  angularDamping: F32_DAMPING,
  layer: {},
  mask: {},
  flags: {},
});

/**
 * Build a `set-body-transform` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetBodyTransform = (): SetBodyTransformCmd => ({
  body: 0,
  position: v3(),
  rotation: q4(),
  teleport: false,
});

/**
 * A pooled `set-body-velocity` payload.
 *
 * WIT makes `linear` an `option<vec3>`; the pool always owns one, so the
 * setter can write through it without a null check or a fresh vector.
 */
type PooledSetBodyVelocity = SetBodyVelocityCmd & { linear: Vec3 };

/**
 * Build a `set-body-velocity` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetBodyVelocity = (): PooledSetBodyVelocity => ({
  body: 0,
  linear: v3(),
  angular: undefined,
});

/**
 * Build an `apply-impulse` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeApplyImpulse = (): ApplyImpulseCmd => ({
  body: 0,
  impulse: v3(),
  atPoint: undefined,
});

/**
 * Build a `set-body-enabled` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetBodyEnabled = (): SetBodyEnabledCmd => ({ body: 0, enabled: true });

/**
 * Build a `move-character` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeMoveCharacter = (): MoveCharacterCmd => ({
  body: 0,
  desiredVelocity: v3(),
  jump: false,
  crouch: false,
  maxSlopeDeg: 45,
});

/**
 * Build a `spawn-character` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSpawnCharacter = (): SpawnCharacterCmd => ({
  entity: 0,
  bundle: 0,
  position: v3(),
  rotation: q4(),
});

/**
 * Build a `set-character-state` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetCharacterState = (): SetCharacterStateCmd => ({
  entity: 0,
  state: 'idle',
  velocity: v3(),
  grounded: true,
});

/**
 * Build a `set-clip-weights` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetClipWeights = (): SetClipWeightsCmd => ({
  entity: 0,
  clips: [],
  weights: EMPTY_WEIGHTS,
  timeScale: 1,
});

/**
 * Build a `set-expression` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetExpression = (): SetExpressionCmd => ({
  entity: 0,
  space: 'arkit52',
  weights: EMPTY_WEIGHTS,
});

/**
 * Build a `look-at` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeLookAt = (): LookAtCmd => ({ entity: 0, target: undefined, weight: 1 });

/**
 * Build a `say` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeConversation = (): ConversationCmd => ({
  entity: 0,
  action: 'end',
  character: '',
  text: '',
});

const makeSay = (): SayCmd => ({ entity: 0, text: '', audio: undefined, visemes: undefined });

/**
 * Build a `play-sound` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makePlaySound = (): PlaySoundCmd => ({
  sound: 0,
  asset: 0,
  entity: undefined,
  position: undefined,
  volume: 1,
  pitch: 1,
  looping: false,
  bus: 'sfx',
});

/**
 * Build a `stop-sound` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeStopSound = (): StopSoundCmd => ({ sound: 0, fadeMs: 0 });

/**
 * Build a `set-listener` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeSetListener = (): SetListenerCmd => ({
  position: v3(),
  rotation: q4(),
  velocity: v3(),
});

/**
 * Build a `load-asset` payload.
 *
 * @returns A fully shaped, zeroed payload.
 */
const makeLoadAsset = (): LoadAssetCmd => ({ asset: 0, priority: 0 });

let poolObjects = 0;

/**
 * Total pooled command slots created since the module loaded.
 *
 * Tests assert this stops growing once a game reaches its steady state.
 *
 * @returns The number of slots ever allocated.
 *
 * @example
 * ```ts
 * const before = commandPoolSize();
 * for (let i = 0; i < 100; i += 1) guest.tick(input);
 * console.log(commandPoolSize() === before); // true, in a steady state
 * ```
 */
export function commandPoolSize(): number {
  return poolObjects;
}

/** A material value holder the pool owns, so the guest's object is not kept. */
type ColorValue = Extract<MaterialValue, { tag: 'color' }>;
/** A material value holder the pool owns, so the guest's object is not kept. */
type VectorValue = Extract<MaterialValue, { tag: 'vector' }>;

/** Builds and owns one frame's `commands` list. */
export class CommandBuffer {
  /** The list handed to the host. Reused every frame; never retain it. */
  readonly list: Command[] = [];

  /** One slot array per tag, indexed by `TAG_ORDINAL`. */
  private readonly slots: Command[][] = [];

  /** Next free slot per tag. `reset()` is one `fill(0)` over this. */
  private readonly cursors = new Int32Array(TAG_COUNT);

  /** Index of the slot the last `take` handed out, for the side stashes. */
  private slot = 0;

  /** Per-slot `look-at` targets, so releasing one does not drop the object. */
  private readonly lookTargets: Vec3[] = [];

  /** Per-slot `set-body-velocity` angular vectors. */
  private readonly angulars: Vec3[] = [];

  /** Per-slot `apply-impulse` application points. */
  private readonly impulsePoints: Vec3[] = [];

  /** Per-slot `set-clip-weights` storage. */
  private readonly clipWeights: Float32Array[] = [];

  /** Per-slot `set-expression` storage. */
  private readonly expressionWeights: Float32Array[] = [];

  constructor() {
    for (let i = 0; i < TAG_COUNT; i += 1) this.slots.push([]);
  }

  /**
   * Rewind for a new frame. Keeps every pooled object alive.
   *
   * @returns Nothing.
   */
  reset(): void {
    this.list.length = 0;
    this.cursors.fill(0);
  }

  /**
   * Take the next pooled slot for a tag, appending it to the frame list.
   *
   * @param tag The command tag.
   * @param make Module-const factory for a fully shaped payload, called only
   *   when the pool has to grow.
   * @returns The payload to mutate. Every field must be written: the slot
   *   still holds whatever the last command with this tag left behind.
   */
  protected take<T>(tag: CommandTag, make: () => T): T {
    const ordinal = TAG_ORDINAL[tag];
    // `noUncheckedIndexedAccess` is off, so read through a view that admits
    // the gap rather than annotating the binding (which control flow narrows).
    const slots = this.slots[ordinal] as (Command | undefined)[];
    const at = this.cursors[ordinal];
    let slot = slots[at];
    if (slot === undefined) {
      slot = { tag, val: make() } as Command;
      slots[at] = slot;
      poolObjects += 1;
    }
    this.cursors[ordinal] = at + 1;
    this.slot = at;
    this.list.push(slot);
    return slot.val as T;
  }

  /**
   * Append a command whose payload is a bare primitive.
   *
   * @param tag The command tag.
   * @param val The primitive payload.
   * @returns Nothing.
   */
  private takePrimitive(tag: CommandTag, val: number | boolean): void {
    const ordinal = TAG_ORDINAL[tag];
    const slots = this.slots[ordinal] as (Command | undefined)[];
    const at = this.cursors[ordinal];
    let slot = slots[at];
    if (slot === undefined) {
      slot = { tag, val } as Command;
      slots[at] = slot;
      poolObjects += 1;
    }
    (slot as { val: number | boolean }).val = val;
    this.cursors[ordinal] = at + 1;
    this.slot = at;
    this.list.push(slot);
  }

  /**
   * The pooled vector for the slot `take` just handed out.
   *
   * @param store The per-slot stash.
   * @param slot The slot index.
   * @returns A vector only this slot uses, so two commands never share one.
   */
  private vecFor(store: Vec3[], slot: number): Vec3 {
    let vec = store[slot] as Vec3 | undefined;
    if (vec === undefined) {
      vec = v3();
      store[slot] = vec;
    }
    return vec;
  }

  /**
   * The pooled `list<f32>` storage for the slot `take` just handed out.
   *
   * Writing a float into a `Float32Array` rounds it exactly as the wasm
   * boundary does, so copying here is what keeps direct mode bit-identical —
   * and it means the host never retains a guest-owned array.
   *
   * @param store The per-slot stash.
   * @param slot The slot index.
   * @param length How many floats the command carries.
   * @returns An array of exactly `length` floats, reused while the length
   *   holds steady.
   */
  private weightsFor(store: Float32Array[], slot: number, length: number): Float32Array {
    let buf = store[slot] as Float32Array | undefined;
    if (buf === undefined || buf.length !== length) {
      buf = new Float32Array(length);
      store[slot] = buf;
    }
    return buf;
  }

  /**
   * Create an entity in the host scene.
   *
   * @param entity Guest-minted entity id.
   * @param asset Renderable asset handle, or `undefined` for a bare node.
   * @param px Position x.
   * @param py Position y.
   * @param pz Position z.
   * @param qx Rotation x.
   * @param qy Rotation y.
   * @param qz Rotation z.
   * @param qw Rotation w.
   * @param sx Scale x.
   * @param sy Scale y.
   * @param sz Scale z.
   * @param name Debug label.
   * @returns Nothing.
   */
  spawn(
    entity: Entity,
    asset: number | undefined,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    sx: number,
    sy: number,
    sz: number,
    name?: string,
  ): void {
    const c = this.take<SpawnCmd>('spawn', makeSpawn);
    c.entity = entity;
    c.asset = asset === 0 ? undefined : asset;
    c.position.x = f(px);
    c.position.y = f(py);
    c.position.z = f(pz);
    c.rotation.x = f(qx);
    c.rotation.y = f(qy);
    c.rotation.z = f(qz);
    c.rotation.w = f(qw);
    c.scale.x = f(sx);
    c.scale.y = f(sy);
    c.scale.z = f(sz);
    c.parent = undefined;
    c.visible = true;
    c.name = name;
  }

  /**
   * Destroy an entity in the host scene.
   *
   * @param entity Entity id.
   * @returns Nothing.
   */
  despawn(entity: Entity): void {
    this.takePrimitive('despawn', entity);
  }

  /**
   * Attach or detach a renderable.
   *
   * @param entity Entity id.
   * @param asset Asset handle, or `undefined` to detach.
   * @returns Nothing.
   */
  setAsset(entity: Entity, asset: number | undefined): void {
    const c = this.take<SetAssetCmd>('set-asset', makeSetAsset);
    c.entity = entity;
    c.asset = asset === 0 ? undefined : asset;
  }

  /**
   * Reparent an entity.
   *
   * @param entity Entity id.
   * @param parent New parent, or `undefined` for the scene root.
   * @param keepWorldTransform Preserve the world transform across the move.
   * @returns Nothing.
   */
  setParent(entity: Entity, parent: Entity | undefined, keepWorldTransform: boolean): void {
    const c = this.take<SetParentCmd>('set-parent', makeSetParent);
    c.entity = entity;
    c.parent = parent === 0 ? undefined : parent;
    c.keepWorldTransform = keepWorldTransform;
  }

  /**
   * Play or cross-fade a clip.
   *
   * @param entity Entity id.
   * @param clip Clip name inside the entity's asset.
   * @param looping Loop the clip.
   * @param speed Playback rate multiplier.
   * @param fadeMs Cross-fade duration in milliseconds.
   * @param weight Target layer weight in 0..1.
   * @returns Nothing.
   */
  setAnim(
    entity: Entity,
    clip: string,
    looping: boolean,
    speed: number,
    fadeMs: number,
    weight: number,
  ): void {
    const c = this.take<SetAnimCmd>('set-anim', makeSetAnim);
    c.entity = entity;
    c.clip = clip;
    c.looping = looping;
    c.speed = f(speed);
    c.fadeMs = f(fadeMs);
    c.weight = f(weight);
  }

  /**
   * Set one material uniform.
   *
   * The value is copied into a pooled holder, rounded to f32: the host never
   * sees the guest's own object, and a colour built inline costs nothing after
   * the first frame. Only a slot that changes variant allocates.
   *
   * @param entity Entity id.
   * @param name Uniform name.
   * @param value The value variant.
   * @returns Nothing.
   */
  setMaterialParam(entity: Entity, name: string, value: MaterialValue): void {
    const c = this.take<SetMaterialParamCmd>('set-material-param', makeSetMaterialParam);
    c.entity = entity;
    c.name = name;
    const held = c.value;
    switch (value.tag) {
      case 'scalar': {
        if (held.tag === 'scalar') held.val = f(value.val);
        else c.value = { tag: 'scalar', val: f(value.val) };
        break;
      }
      case 'boolean': {
        if (held.tag === 'boolean') held.val = value.val;
        else c.value = { tag: 'boolean', val: value.val };
        break;
      }
      case 'texture': {
        if (held.tag === 'texture') held.val = value.val;
        else c.value = { tag: 'texture', val: value.val };
        break;
      }
      case 'color': {
        let holder: ColorValue;
        if (held.tag === 'color') holder = held;
        else {
          holder = { tag: 'color', val: { r: 0, g: 0, b: 0, a: 1 } };
          c.value = holder;
        }
        holder.val.r = f(value.val.r);
        holder.val.g = f(value.val.g);
        holder.val.b = f(value.val.b);
        holder.val.a = f(value.val.a);
        break;
      }
      default: {
        let holder: VectorValue;
        if (held.tag === 'vector') holder = held;
        else {
          holder = { tag: 'vector', val: v3() };
          c.value = holder;
        }
        holder.val.x = f(value.val.x);
        holder.val.y = f(value.val.y);
        holder.val.z = f(value.val.z);
        break;
      }
    }
  }

  /**
   * Create a rigid body or character controller.
   *
   * @param body Guest-minted body id.
   * @param entity Entity the body drives.
   * @param kind Body class.
   * @param shape Collision shape family.
   * @param hx Half-extent / radius lane 0.
   * @param hy Half-extent / half-height lane 1.
   * @param hz Half-extent lane 2.
   * @param px Position x.
   * @param py Position y.
   * @param pz Position z.
   * @param mass Kilograms; ignored for fixed and kinematic bodies.
   * @param layer What this body is.
   * @param mask What this body collides with.
   * @param flags Per-body switches.
   * @returns The payload, so the caller can tune friction and damping. Round
   *   anything written onto it with `Math.fround`.
   */
  addBody(
    body: BodyId,
    entity: Entity,
    kind: BodyKind,
    shape: ShapeKind,
    hx: number,
    hy: number,
    hz: number,
    px: number,
    py: number,
    pz: number,
    mass: number,
    layer: CollisionLayers,
    mask: CollisionLayers,
    flags: BodyFlags,
  ): AddBodyCmd {
    const c = this.take<AddBodyCmd>('add-body', makeAddBody);
    c.body = body;
    c.entity = entity;
    c.kind = kind;
    c.shape.kind = shape;
    c.shape.halfExtents.x = f(hx);
    c.shape.halfExtents.y = f(hy);
    c.shape.halfExtents.z = f(hz);
    c.shape.asset = undefined;
    c.position.x = f(px);
    c.position.y = f(py);
    c.position.z = f(pz);
    c.rotation.x = 0;
    c.rotation.y = 0;
    c.rotation.z = 0;
    c.rotation.w = 1;
    c.mass = f(mass);
    c.friction = F32_HALF;
    c.restitution = 0;
    c.linearDamping = F32_DAMPING;
    c.angularDamping = F32_DAMPING;
    c.layer = layer;
    c.mask = mask;
    c.flags = flags;
    return c;
  }

  /**
   * Destroy a body.
   *
   * @param body Body id.
   * @returns Nothing.
   */
  removeBody(body: BodyId): void {
    this.takePrimitive('remove-body', body);
  }

  /**
   * Move a body directly.
   *
   * @param body Body id.
   * @param px Position x.
   * @param py Position y.
   * @param pz Position z.
   * @param qx Rotation x.
   * @param qy Rotation y.
   * @param qz Rotation z.
   * @param qw Rotation w.
   * @param teleport Clear velocities and skip interpolation.
   * @returns Nothing.
   */
  setBodyTransform(
    body: BodyId,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    teleport: boolean,
  ): void {
    const c = this.take<SetBodyTransformCmd>('set-body-transform', makeSetBodyTransform);
    c.body = body;
    c.position.x = f(px);
    c.position.y = f(py);
    c.position.z = f(pz);
    c.rotation.x = f(qx);
    c.rotation.y = f(qy);
    c.rotation.z = f(qz);
    c.rotation.w = f(qw);
    c.teleport = teleport;
  }

  /**
   * Overwrite a body's velocity.
   *
   * @param body Body id.
   * @param x Linear x.
   * @param y Linear y.
   * @param z Linear z.
   * @param ax Angular x, radians per second. Omit to leave spin alone.
   * @param ay Angular y.
   * @param az Angular z.
   * @returns Nothing.
   */
  setBodyVelocity(
    body: BodyId,
    x: number,
    y: number,
    z: number,
    ax?: number,
    ay?: number,
    az?: number,
  ): void {
    const c = this.take<PooledSetBodyVelocity>('set-body-velocity', makeSetBodyVelocity);
    const slot = this.slot;
    c.body = body;
    c.linear.x = f(x);
    c.linear.y = f(y);
    c.linear.z = f(z);
    if (ax === undefined) {
      c.angular = undefined;
      return;
    }
    const angular = this.vecFor(this.angulars, slot);
    angular.x = f(ax);
    angular.y = f(ay ?? 0);
    angular.z = f(az ?? 0);
    c.angular = angular;
  }

  /**
   * Apply a one-shot impulse.
   *
   * @param body Body id.
   * @param x Impulse x.
   * @param y Impulse y.
   * @param z Impulse z.
   * @param atX World-space application point x. Omit for the centre of mass.
   * @param atY Application point y.
   * @param atZ Application point z.
   * @returns Nothing.
   */
  applyImpulse(
    body: BodyId,
    x: number,
    y: number,
    z: number,
    atX?: number,
    atY?: number,
    atZ?: number,
  ): void {
    const c = this.take<ApplyImpulseCmd>('apply-impulse', makeApplyImpulse);
    const slot = this.slot;
    c.body = body;
    c.impulse.x = f(x);
    c.impulse.y = f(y);
    c.impulse.z = f(z);
    if (atX === undefined) {
      c.atPoint = undefined;
      return;
    }
    const at = this.vecFor(this.impulsePoints, slot);
    at.x = f(atX);
    at.y = f(atY ?? 0);
    at.z = f(atZ ?? 0);
    c.atPoint = at;
  }

  /**
   * Enable or disable a body in the broad phase.
   *
   * @param body Body id.
   * @param enabled Whether the body participates.
   * @returns Nothing.
   */
  setBodyEnabled(body: BodyId, enabled: boolean): void {
    const c = this.take<SetBodyEnabledCmd>('set-body-enabled', makeSetBodyEnabled);
    c.body = body;
    c.enabled = enabled;
  }

  /**
   * Drive a character body for one step.
   *
   * @param body Body id of a `character` body.
   * @param vx Desired velocity x.
   * @param vy Desired velocity y.
   * @param vz Desired velocity z.
   * @param jump Request a jump this step.
   * @param crouch Request a crouch this step.
   * @param maxSlopeDeg Maximum walkable slope in degrees.
   * @returns Nothing.
   */
  moveCharacter(
    body: BodyId,
    vx: number,
    vy: number,
    vz: number,
    jump: boolean,
    crouch: boolean,
    maxSlopeDeg: number,
  ): void {
    const c = this.take<MoveCharacterCmd>('move-character', makeMoveCharacter);
    c.body = body;
    c.desiredVelocity.x = f(vx);
    c.desiredVelocity.y = f(vy);
    c.desiredVelocity.z = f(vz);
    c.jump = jump;
    c.crouch = crouch;
    c.maxSlopeDeg = f(maxSlopeDeg);
  }

  /**
   * Instantiate a splat character bundle.
   *
   * @param entity Guest-minted entity id.
   * @param bundle Character bundle asset handle.
   * @param px Position x.
   * @param py Position y.
   * @param pz Position z.
   * @param qx Rotation x.
   * @param qy Rotation y.
   * @param qz Rotation z.
   * @param qw Rotation w.
   * @returns Nothing.
   */
  spawnCharacter(
    entity: Entity,
    bundle: number,
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void {
    const c = this.take<SpawnCharacterCmd>('spawn-character', makeSpawnCharacter);
    c.entity = entity;
    c.bundle = bundle;
    c.position.x = f(px);
    c.position.y = f(py);
    c.position.z = f(pz);
    c.rotation.x = f(qx);
    c.rotation.y = f(qy);
    c.rotation.z = f(qz);
    c.rotation.w = f(qw);
  }

  /**
   * Drive a character's locomotion state machine.
   *
   * @param entity Entity id.
   * @param state State name, for example `'idle' | 'walk' | 'run'`.
   * @param vx Velocity x.
   * @param vy Velocity y.
   * @param vz Velocity z.
   * @param grounded Whether the character is on the ground.
   * @returns Nothing.
   */
  setCharacterState(
    entity: Entity,
    state: string,
    vx: number,
    vy: number,
    vz: number,
    grounded: boolean,
  ): void {
    const c = this.take<SetCharacterStateCmd>('set-character-state', makeSetCharacterState);
    c.entity = entity;
    c.state = state;
    c.velocity.x = f(vx);
    c.velocity.y = f(vy);
    c.velocity.z = f(vz);
    c.grounded = grounded;
  }

  /**
   * Set explicit per-clip weights.
   *
   * @param entity Entity id.
   * @param clips Clip names.
   * @param weights Positional weights; must match `clips` in length. Copied
   *   into pooled storage, so the caller may reuse its own array freely.
   * @param timeScale Playback rate for the whole layer.
   * @returns Nothing.
   */
  setClipWeights(
    entity: Entity,
    clips: readonly string[],
    weights: readonly number[] | Float32Array,
    timeScale: number,
  ): void {
    const c = this.take<SetClipWeightsCmd>('set-clip-weights', makeSetClipWeights);
    const slot = this.slot;
    c.entity = entity;
    c.clips = clips;
    const n = weights.length;
    const buf = this.weightsFor(this.clipWeights, slot, n);
    for (let i = 0; i < n; i += 1) buf[i] = weights[i] ?? 0;
    c.weights = buf;
    c.timeScale = f(timeScale);
  }

  /**
   * Set facial expression coefficients.
   *
   * @param entity Entity id.
   * @param space Coordinate space the weights are in.
   * @param weights Coefficients; length must match the space. Copied into
   *   pooled storage, so the caller may reuse its own array freely.
   * @returns Nothing.
   */
  setExpression(
    entity: Entity,
    space: ExpressionSpace,
    weights: readonly number[] | Float32Array,
  ): void {
    const c = this.take<SetExpressionCmd>('set-expression', makeSetExpression);
    const slot = this.slot;
    c.entity = entity;
    c.space = space;
    const n = weights.length;
    const buf = this.weightsFor(this.expressionWeights, slot, n);
    for (let i = 0; i < n; i += 1) buf[i] = weights[i] ?? 0;
    c.weights = buf;
  }

  /**
   * Aim a character's head and eyes.
   *
   * @param entity Entity id.
   * @param target World-space point, or `null` to release the look-at.
   * @param weight Blend weight in 0..1.
   * @returns Nothing.
   */
  lookAt(entity: Entity, target: Vec3 | null, weight: number): void {
    const c = this.take<LookAtCmd>('look-at', makeLookAt);
    const slot = this.slot;
    c.entity = entity;
    if (target === null) {
      c.target = undefined;
    } else {
      const t = this.vecFor(this.lookTargets, slot);
      t.x = f(target.x);
      t.y = f(target.y);
      t.z = f(target.z);
      c.target = t;
    }
    c.weight = f(weight);
  }

  /**
   * Speak a line.
   *
   * @param entity Entity id.
   * @param text Subtitle text.
   * @param audio Voice line asset handle.
   * @param visemes Viseme track as JSON.
   * @returns Nothing.
   */
  say(entity: Entity, text: string, audio?: number, visemes?: string): void {
    const c = this.take<SayCmd>('say', makeSay);
    c.entity = entity;
    c.text = text;
    c.audio = audio === 0 ? undefined : audio;
    c.visemes = visemes;
  }

  /** Control an optional host conversation module using pooled commands.
   *
   * @param entity Interviewed entity.
   * @param action Lifecycle or text command.
   * @param character Configured character id, never a URL.
   * @param text Typed/transcribed question; empty for lifecycle commands.
   */
  conversation(entity: Entity, action: ConversationCmd['action'], character = '', text = ''): void {
    const c = this.take<ConversationCmd>('conversation', makeConversation);
    c.entity = entity >>> 0;
    c.action = action;
    c.character = character;
    c.text = text;
  }

  /**
   * Start a sound.
   *
   * @param sound Guest-minted sound handle.
   * @param asset Audio asset handle.
   * @param entity Entity to follow, or `undefined` for a non-positional sound.
   * @param volume Linear gain in 0..1.
   * @param pitch Playback-rate multiplier.
   * @param looping Loop the sound.
   * @param bus Mixer bus.
   * @returns Nothing.
   */
  playSound(
    sound: SoundId,
    asset: number,
    entity: Entity | undefined,
    volume: number,
    pitch: number,
    looping: boolean,
    bus: AudioBus,
  ): void {
    const c = this.take<PlaySoundCmd>('play-sound', makePlaySound);
    c.sound = sound;
    c.asset = asset;
    c.entity = entity === 0 ? undefined : entity;
    c.position = undefined;
    c.volume = f(volume);
    c.pitch = f(pitch);
    c.looping = looping;
    c.bus = bus;
  }

  /**
   * Stop a playing sound.
   *
   * @param sound Sound handle.
   * @param fadeMs Fade-out in milliseconds.
   * @returns Nothing.
   */
  stopSound(sound: SoundId, fadeMs: number): void {
    const c = this.take<StopSoundCmd>('stop-sound', makeStopSound);
    c.sound = sound;
    c.fadeMs = f(fadeMs);
  }

  /**
   * Place the audio listener.
   *
   * @param px Position x.
   * @param py Position y.
   * @param pz Position z.
   * @param qx Rotation x.
   * @param qy Rotation y.
   * @param qz Rotation z.
   * @param qw Rotation w.
   * @returns Nothing.
   */
  setListener(
    px: number,
    py: number,
    pz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void {
    const c = this.take<SetListenerCmd>('set-listener', makeSetListener);
    c.position.x = f(px);
    c.position.y = f(py);
    c.position.z = f(pz);
    c.rotation.x = f(qx);
    c.rotation.y = f(qy);
    c.rotation.z = f(qz);
    c.rotation.w = f(qw);
    c.velocity.x = 0;
    c.velocity.y = 0;
    c.velocity.z = 0;
  }

  /**
   * Ask the host to start loading an asset.
   *
   * @param asset Asset handle.
   * @param priority Higher runs first.
   * @returns Nothing.
   */
  loadAsset(asset: number, priority: number): void {
    const c = this.take<LoadAssetCmd>('load-asset', makeLoadAsset);
    c.asset = asset;
    c.priority = priority;
  }

  /**
   * Request or release pointer lock.
   *
   * @param locked Whether the canvas should hold pointer lock.
   * @returns Nothing.
   */
  setPointerLock(locked: boolean): void {
    this.takePrimitive('set-pointer-lock', locked);
  }

  /**
   * Scale simulated time.
   *
   * @param scale Multiplier; 1 is real time.
   * @returns Nothing.
   */
  setTimeScale(scale: number): void {
    this.takePrimitive('set-time-scale', scale);
  }
}
