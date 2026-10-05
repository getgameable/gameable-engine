/**
 * Plain-JavaScript mirrors of the `gameable:engine@0.2.0` WIT vocabulary, in the
 * exact shapes jco lifts and lowers.
 *
 * Two rules drive every declaration here:
 *
 * 1. Lists the guest *receives* are typed `ArrayLike<number>`, never
 *    `Float32Array`. In wasm mode jco hands the guest a plain `Array`; in
 *    direct mode the host hands it a `Float32Array`. `ArrayLike` is the only
 *    type both satisfy, and it makes `.subarray()` a compile error.
 * 2. Flags the guest *receives* have every key present; flags the guest
 *    emits* may omit keys, which lower as `false`.
 *
 * The net and data records (0.2.0) live in `netTypes.ts` and are re-exported here.
 */
import type { NetCommand, NetEvent, PlayerInput } from './netTypes';

export type * from './netTypes';

/** ECS entity handle. `0` is reserved and means "none". */
export type Entity = number;
/** Rigid body / character controller handle. */
export type BodyId = number;
/** Manifest asset handle, resolved from a string id. */
export type AssetId = number;
/** Playing-sound handle. */
export type SoundId = number;

/** A 3-component vector. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A unit quaternion in xyzw order (three.js / Jolt order). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Linear RGBA, components in 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Log severity accepted by `env.log`. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Physics body class. `fixed` is what other engines call `static`. */
export type BodyKind = 'fixed' | 'kinematic' | 'dynamic' | 'character';

/** Collision shape family. */
export type ShapeKind =
  'box' | 'sphere' | 'capsule' | 'cylinder' | 'plane' | 'convex-hull' | 'mesh' | 'height-field';

/** Manifest asset family. */
export type AssetKind = 'splat' | 'gltf' | 'character' | 'audio' | 'collider' | 'data';

/** Camera rig family. */
export type CameraMode = 'first-person' | 'third-person' | 'free' | 'fixed';

/** Camera projection family. */
export type ProjectionKind = 'perspective' | 'orthographic';

/** Audio mixer bus. */
export type AudioBus = 'master' | 'music' | 'sfx' | 'voice' | 'ui';

/** Coordinate space for `setExpression` weights. */
export type ExpressionSpace = 'arkit52' | 'gnm' | 'gnm68';

/** Lifecycle phase of a contact. */
export type ContactPhase = 'begin' | 'stay' | 'end';

/** Machine-readable half of a `GameError`. */
export type ErrorCode =
  | 'init-failed'
  | 'tick-failed'
  | 'invalid-state'
  | 'unsupported'
  | 'asset-missing'
  | 'snapshot-version-mismatch'
  | 'internal';

/** Keyboard modifier state. Every key is present on input. */
export interface InputMods {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
  capsLock: boolean;
  numLock: boolean;
}

/** Broad-phase layer set. Omitted keys lower as `false`. */
export interface CollisionLayers {
  defaultLayer?: boolean;
  staticGeometry?: boolean;
  player?: boolean;
  enemy?: boolean;
  projectile?: boolean;
  pickup?: boolean;
  trigger?: boolean;
  character?: boolean;
  debris?: boolean;
  water?: boolean;
  user0?: boolean;
  user1?: boolean;
  user2?: boolean;
  user3?: boolean;
  user4?: boolean;
  user5?: boolean;
}

/** Per-body behaviour switches. Omitted keys lower as `false`. */
export interface BodyFlags {
  reportContacts?: boolean;
  sensor?: boolean;
  noSleep?: boolean;
  lockRotation?: boolean;
  ccd?: boolean;
  debugDraw?: boolean;
}

/** 256 key codes packed into 8 `u32` words, one list per edge. */
export interface KeyState {
  down: ArrayLike<number>;
  pressed: ArrayLike<number>;
  released: ArrayLike<number>;
}

/** Pointer position, deltas, wheel and button edges for one frame. */
export interface MouseState {
  x: number;
  y: number;
  dx: number;
  dy: number;
  wheel: number;
  buttons: number;
  pressed: number;
  released: number;
  locked: boolean;
}

/** One gamepad in the standard mapping. */
export interface GamepadState {
  index: number;
  connected: boolean;
  buttons: number;
  pressed: number;
  released: number;
  axes: ArrayLike<number>;
}

/** Everything the host knows about input for one fixed step. */
export interface InputState {
  keys: KeyState;
  mods: InputMods;
  mouse: MouseState;
  gamepads: readonly GamepadState[];
  focused: boolean;
}

/** Which bodies a physics query considers. */
export interface QueryFilter {
  layers: CollisionLayers;
  excludeBody?: BodyId;
  excludeEntity?: Entity;
  solidOnly: boolean;
}

/** One ray in a `raycastBatch` call. */
export interface RayQuery {
  origin: Vec3;
  direction: Vec3;
  maxDistance: number;
  filter: QueryFilter;
}

/** Closest hit along a ray. */
export interface RayHit {
  body: BodyId;
  entity: Entity;
  point: Vec3;
  normal: Vec3;
  distance: number;
}

/** One body overlapping a query volume. */
export interface OverlapHit {
  body: BodyId;
  entity: Entity;
  point: Vec3;
  depth: number;
}

/** Manifest metadata for one asset handle. */
export interface AssetDesc {
  id: AssetId;
  name: string;
  kind: AssetKind;
  tags: readonly string[];
  ready: boolean;
  hasCollider: boolean;
  rig?: string;
}

/** One reported contact between two bodies. */
export interface Contact {
  a: BodyId;
  b: BodyId;
  entityA: Entity;
  entityB: Entity;
  phase: ContactPhase;
  point: Vec3;
  normal: Vec3;
  impulse: number;
}

/** An asset finished loading. */
export interface AssetLoadedEvent {
  asset: AssetId;
  name: string;
}

/** A character bundle finished loading and reported its expression space. */
export interface CharacterReadyEvent {
  entity: Entity;
  bundle: AssetId;
  space: ExpressionSpace;
  expressionDim: number;
}

/** A playing sound stopped. */
export interface SoundEndedEvent {
  sound: SoundId;
  completed: boolean;
}

/** An animation clip passed a named marker. */
export interface AnimEventData {
  entity: Entity;
  clip: string;
  name: string;
  time: number;
}

/** The viewport changed size. */
export interface ResizedEvent {
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** A host-side occurrence since the previous tick. */
export type GameEvent =
  | { tag: 'conversation-event'; val: ConversationEvent }
  | { tag: 'asset-loaded'; val: AssetLoadedEvent }
  | { tag: 'character-ready'; val: CharacterReadyEvent }
  | { tag: 'sound-ended'; val: SoundEndedEvent }
  | { tag: 'anim-event'; val: AnimEventData }
  | { tag: 'resized'; val: ResizedEvent }
  | NetEvent;

/** The camera the host should render from this frame. */
export interface CameraState {
  mode: CameraMode;
  projection: ProjectionKind;
  position: Vec3;
  rotation: Quat;
  target?: Vec3;
  fovYDeg: number;
  near: number;
  far: number;
  follow?: Entity;
  armLength: number;
  offset: Vec3;
}

/** The error payload of `init` and `restore`. */
export interface GameError {
  code: ErrorCode;
  message: string;
}

/** Collision shape description carried by `add-body`. */
export interface Shape {
  kind: ShapeKind;
  halfExtents: Vec3;
  asset?: AssetId;
}

/** A material parameter value. */
export type MaterialValue =
  | { tag: 'scalar'; val: number }
  | { tag: 'boolean'; val: boolean }
  | { tag: 'color'; val: Rgba }
  | { tag: 'vector'; val: Vec3 }
  | { tag: 'texture'; val: AssetId };

/** Create an entity, optionally with a renderable asset. */
export interface SpawnCmd {
  entity: Entity;
  asset?: AssetId;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
  parent?: Entity;
  visible: boolean;
  name?: string;
}

/** Attach or detach an entity's renderable. */
export interface SetAssetCmd {
  entity: Entity;
  asset?: AssetId;
}

/** Reparent an entity in the scene graph. */
export interface SetParentCmd {
  entity: Entity;
  parent?: Entity;
  keepWorldTransform: boolean;
}

/** Play or cross-fade an animation clip on one layer. */
export interface SetAnimCmd {
  entity: Entity;
  clip: string;
  looping: boolean;
  speed: number;
  fadeMs: number;
  weight: number;
}

/** Set one material uniform. */
export interface SetMaterialParamCmd {
  entity: Entity;
  name: string;
  value: MaterialValue;
}

/** Create a rigid body or character controller. */
export interface AddBodyCmd {
  body: BodyId;
  entity: Entity;
  kind: BodyKind;
  shape: Shape;
  position: Vec3;
  rotation: Quat;
  mass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  layer: CollisionLayers;
  mask: CollisionLayers;
  flags: BodyFlags;
}

/** Move a body directly. */
export interface SetBodyTransformCmd {
  body: BodyId;
  position: Vec3;
  rotation: Quat;
  teleport: boolean;
}

/** Overwrite a body's velocities. `undefined` leaves one untouched. */
export interface SetBodyVelocityCmd {
  body: BodyId;
  linear?: Vec3;
  angular?: Vec3;
}

/** Apply a one-shot impulse. */
export interface ApplyImpulseCmd {
  body: BodyId;
  impulse: Vec3;
  atPoint?: Vec3;
}

/** Enable or disable a body in the broad phase. */
export interface SetBodyEnabledCmd {
  body: BodyId;
  enabled: boolean;
}

/** Drive a `character` body for one step. */
export interface MoveCharacterCmd {
  body: BodyId;
  desiredVelocity: Vec3;
  jump: boolean;
  crouch: boolean;
  maxSlopeDeg: number;
}

/** Instantiate a splat character bundle. */
export interface SpawnCharacterCmd {
  entity: Entity;
  bundle: AssetId;
  position: Vec3;
  rotation: Quat;
}

/** Drive a character's locomotion state machine. */
export interface SetCharacterStateCmd {
  entity: Entity;
  state: string;
  velocity: Vec3;
  grounded: boolean;
}

/** Set explicit per-clip weights on a character's body layer. */
export interface SetClipWeightsCmd {
  entity: Entity;
  clips: readonly string[];
  weights: readonly number[] | Float32Array;
  timeScale: number;
}

/** Set a character's facial expression coefficients. */
export interface SetExpressionCmd {
  entity: Entity;
  space: ExpressionSpace;
  weights: readonly number[] | Float32Array;
}

/** Aim a character's head and eyes at a world point. */
export interface LookAtCmd {
  entity: Entity;
  target?: Vec3;
  weight: number;
}

/** Structural interview controls; service addresses stay in host configuration. */
export interface ConversationCmd {
  entity: Entity;
  action: 'start' | 'end' | 'ask' | 'interrupt' | 'microphone-on' | 'microphone-off';
  character: string;
  text: string;
}
/** Low-frequency conversation UI/input event. No audio or facial frames cross WIT. */
export interface ConversationEvent {
  entity: Entity;
  kind: 'input' | 'status' | 'subtitle' | 'error' | 'story';
  /** Story events carry the versioned full snapshot as JSON. */
  text: string;
}

/** Speak a line, optionally with audio and a viseme track. */
export interface SayCmd {
  entity: Entity;
  text: string;
  audio?: AssetId;
  visemes?: string;
}

/** Start a sound. */
export interface PlaySoundCmd {
  sound: SoundId;
  asset: AssetId;
  entity?: Entity;
  position?: Vec3;
  volume: number;
  pitch: number;
  looping: boolean;
  bus: AudioBus;
}

/** Stop a playing sound. */
export interface StopSoundCmd {
  sound: SoundId;
  fadeMs: number;
}

/** Place the audio listener. */
export interface SetListenerCmd {
  position: Vec3;
  rotation: Quat;
  velocity: Vec3;
}

/** Ask the host to start loading an asset. */
export interface LoadAssetCmd {
  asset: AssetId;
  priority: number;
}

/** Everything the guest can ask the host to do, applied front to back. */
export type Command =
  | { tag: 'conversation'; val: ConversationCmd }
  | { tag: 'spawn'; val: SpawnCmd }
  | { tag: 'despawn'; val: Entity }
  | { tag: 'set-asset'; val: SetAssetCmd }
  | { tag: 'set-parent'; val: SetParentCmd }
  | { tag: 'set-anim'; val: SetAnimCmd }
  | { tag: 'set-material-param'; val: SetMaterialParamCmd }
  | { tag: 'add-body'; val: AddBodyCmd }
  | { tag: 'remove-body'; val: BodyId }
  | { tag: 'set-body-transform'; val: SetBodyTransformCmd }
  | { tag: 'set-body-velocity'; val: SetBodyVelocityCmd }
  | { tag: 'apply-impulse'; val: ApplyImpulseCmd }
  | { tag: 'set-body-enabled'; val: SetBodyEnabledCmd }
  | { tag: 'move-character'; val: MoveCharacterCmd }
  | { tag: 'spawn-character'; val: SpawnCharacterCmd }
  | { tag: 'set-character-state'; val: SetCharacterStateCmd }
  | { tag: 'set-clip-weights'; val: SetClipWeightsCmd }
  | { tag: 'set-expression'; val: SetExpressionCmd }
  | { tag: 'look-at'; val: LookAtCmd }
  | { tag: 'say'; val: SayCmd }
  | { tag: 'play-sound'; val: PlaySoundCmd }
  | { tag: 'stop-sound'; val: StopSoundCmd }
  | { tag: 'set-listener'; val: SetListenerCmd }
  | { tag: 'load-asset'; val: LoadAssetCmd }
  | { tag: 'set-pointer-lock'; val: boolean }
  | { tag: 'set-time-scale'; val: number }
  | NetCommand;

/** Every `Command['tag']`, useful for exhaustive host-side switches. */
export type CommandTag = Command['tag'];

/** One fixed simulation step of host state handed to the guest. */
export interface FrameInput {
  /**
   * Monotonic fixed-step counter. jco lifts `u64` as a `bigint` on the host
   * and a `number` in the guest, so both are legal here; the runtime
   * `Number()`s it once, on the way in.
   */
  frame: number | bigint;
  dt: number;
  elapsed: number;
  input: InputState;
  /** Post-step body transforms, stride 15, sorted ascending by body id. */
  bodies: ArrayLike<number>;
  contacts: readonly Contact[];
  events: readonly GameEvent[];
  /**
   * Every player's input in a room, ascending by id. Empty for a single-player
   * game. A held seat (its player dropped) is left out until they are back.
   */
  players: readonly PlayerInput[];
}

/** Everything the guest hands back for one fixed step. */
export interface FrameOutput {
  /** Entity transforms, stride 12. Never empty: see the zero-row rule. */
  transforms: Float32Array;
  commands: readonly Command[];
  /** Applied by the authority after `commands`; never forwarded to a client. */
  localCommands: readonly Command[];
  camera: CameraState;
  /** HUD JSON, present only on the frames it changed. */
  hud?: string;
}

/** The `init` payload. */
export interface GameConfig {
  /**
   * Deterministic run seed. A `bigint` on the host, a `number` in the guest;
   * the runtime `Number()`s it once, on the way in.
   */
  seed: number | bigint;
  fixedHz: number;
  viewportWidth: number;
  viewportHeight: number;
  devMode: boolean;
  options?: string;
}

/**
 * The host services a guest may call, in guest-side JS shapes.
 *
 * This is the SDK's own narrow view of the three `gameable:engine` import
 * interfaces. `packages/sdk/src/wit/entry.ts` adapts the real WIT imports to
 * it; `gameable/test` implements it directly for node tests.
 */
export interface HostApi {
  /** Route a message to the host logger. */
  log(level: LogLevel, msg: string): void;
  /** The deterministic run seed, as a `number` (already `Number()`-coerced). */
  seed(): number;
  /** Monotonic milliseconds since engine start. Never feed this to simulation. */
  nowMs(): number;
  /** Closest hit along a ray, or nullish on a miss. */
  raycast(
    origin: Vec3,
    direction: Vec3,
    maxDistance: number,
    filter: QueryFilter,
  ): RayHit | undefined | null;
  /** One round trip for many rays; result index `i` matches `rays[i]`. */
  raycastBatch(rays: readonly RayQuery[]): readonly (RayHit | undefined | null)[];
  /** Bodies overlapping a sphere, nearest first. */
  overlapSphere(
    center: Vec3,
    radius: number,
    filter: QueryFilter,
    maxResults: number,
  ): readonly OverlapHit[];
  /** Manifest string id to handle, or nullish when the manifest has no entry. */
  resolveId(name: string): AssetId | undefined | null;
  /** Metadata for a handle, or nullish when the handle is unknown. */
  describe(id: AssetId): AssetDesc | undefined | null;
}

/**
 * `frame-input` in **host-side** shapes.
 *
 * jco lifts `u64` to `bigint` on the host and to `number` in the guest, and
 * the host is free to hand over real typed arrays. Everything else is
 * identical, which is why the guest types accept `ArrayLike<number>`.
 */
export interface HostFrameInput {
  frame: bigint;
  dt: number;
  elapsed: number;
  input: InputState;
  bodies: Float32Array;
  contacts: readonly Contact[];
  events: readonly GameEvent[];
  players: readonly PlayerInput[];
}

/** `game-config` in host-side shapes: `seed` is a `bigint`. */
export interface HostGameConfig {
  seed: bigint;
  fixedHz: number;
  viewportWidth: number;
  viewportHeight: number;
  devMode: boolean;
  options?: string;
}

/** The five functions the WIT `game` interface exports. */
export interface GuestExports {
  init(config: GameConfig): void;
  tick(input: FrameInput): FrameOutput;
  shutdown(): void;
  snapshot(): Uint8Array;
  restore(state: ArrayLike<number>): void;
}
