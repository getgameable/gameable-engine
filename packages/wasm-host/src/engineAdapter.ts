/**
 * The real {@link EngineAdapter}: `frame-output` applied to `gameable/core`.
 *
 * `adapter.ts` defines the interface and a recording stub. This file is the
 * implementation a browser actually runs: it owns the entity-to-`Object3D`
 * mapping, the previous/current transform pairs the renderer interpolates
 * between, and the translation from the WIT command vocabulary into the host
 * modules' own APIs.
 *
 * **Dependency direction.** The host modules are reached through
 * `engine.get(...)`, and their types are imported `type`-only, so this package
 * gains no runtime dependency on `gameable/physics`,
 * `gameable/audio`, `gameable/input` or `gameable/splat`. A game that
 * leaves a module out simply gets the matching commands ignored, with one
 * warning, instead of a crash.
 *
 * **Rendering before the assets arrive.** A spawn whose asset is unknown, or
 * known but not yet resident, gets a placeholder mesh sized from the entity's
 * physics shape. That is why a fresh scaffold shows capsules and boxes rather
 * than an empty scene, and why swapping a real model in is a manifest change
 * and nothing else.
 */
import { createThirdPersonRig, TransformStore } from '@gameable/core';
import type { CollisionProbe, Engine, EngineModule, ThirdPersonRig } from '@gameable/core';
import { TRANSFORM_FLAGS, TRANSFORM_STRIDE } from '@gameable/sdk';
import type {
  AssetId,
  AudioBus,
  BodyId,
  CameraState,
  CollisionLayers,
  Entity,
  GameEvent,
  HostApi,
  MaterialValue,
  Quat,
  SoundId,
  Vec3,
} from '@gameable/sdk';
import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  SphereGeometry,
} from 'three/webgpu';
import type { BufferGeometry, Material, Object3D } from 'three/webgpu';

// Type-only: these packages are never imported at runtime.
import type { AudioEngine, BusName } from '@gameable/audio';
import type { InputService } from '@gameable/input';
import type { PhysicsService } from '@gameable/physics-jolt';
import type { SplatService } from '@gameable/splat';

import type { EngineAdapter } from './adapter/EngineAdapter';
import { PlayerCommands, type PlayerCommandOptions } from './adapter/PlayerCommands';
import {
  addBodySkip,
  BODY_STRIDE,
  isGuestShape,
  jumpSpeed,
  layerBits,
  shapeKind,
  toJoltBody,
  warnDroppedMoveFields,
  type JoltShapeKind,
} from './adapter/bodyShapes';
import { HostQueries, type HostQueriesOptions } from './adapter/HostQueries';
import { lookup } from './adapter/lookup';
// Type-only, and deliberately so: `characters.ts` is the optional half of this
// package and imports `gameable/character`, `gameable/animation` and
// `gameable/splat` at runtime. Naming the interface here costs nothing; a
// game that never imports `gameable/host/characters` never ships them.
import type { CharacterBridge } from './characters';
import { createDomHud, type HudElement, type HudRenderer } from './hud';

/**
 * Declared parameters a `moveCharacter` must have before the adapter will
 * hand it `crouch` and `maxSlopeDeg`.
 *
 * Duck-typing on arity, because the physics module is reached through
 * `engine.get('physics')` and may be any implementation. A provider that wants
 * these fields declares all four parameters; one that declares them optional
 * (`crouch?`) reports an arity of two and is treated as not supporting them,
 * which is the safe way round — the adapter warns rather than silently
 * dropping a crouch.
 */
const EXTENDED_MOVE_ARITY = 4;

/**
 * Declared parameters an audio `stop` must have before the adapter will hand
 * it a fade. Duck-typed for the same reason as {@link EXTENDED_MOVE_ARITY}.
 */
const FADED_STOP_ARITY = 2;

/** A physics module that accepts the whole `move-character` command. */
interface ExtendedPhysics {
  /**
   * Drive a character for one step, crouch and slope limit included.
   *
   * @param id Body id.
   * @param velocity Desired world-space velocity.
   * @param crouch Whether the character is crouching this step.
   * @param maxSlopeDeg Walkable slope limit in degrees.
   */
  moveCharacter(
    id: BodyId,
    velocity: readonly number[],
    crouch: boolean,
    maxSlopeDeg: number,
  ): void;
}

/** An audio module that can fade a sound out rather than cutting it. */
interface FadingAudio {
  /**
   * Stop a sound over a fade.
   *
   * @param id Sound handle.
   * @param fadeMs Fade-out in milliseconds.
   */
  stop(id: SoundId, fadeMs: number): void;
}

/**
 * How many parameters a service's method declares.
 *
 * Read through an index rather than a member expression so that no unbound
 * method reference is created; the adapter only ever calls these methods on
 * their own object.
 *
 * @param host The service.
 * @param method Method name.
 * @returns The declared parameter count, or 0 when there is no such method.
 */
function arityOf(host: object, method: string): number {
  const fn = (host as Record<string, unknown>)[method];
  return typeof fn === 'function' ? fn.length : 0;
}

/** Transform-store slot the camera borrows. Entity ids start at 1. */
const CAMERA_SLOT = 0;

/** Colour a placeholder uses until a game tints it. */
const PLACEHOLDER_COLOUR = 0x9aa3b8;

/**
 * What the third-person spring arm probes against.
 *
 * The world, and only the world. Probing actors too would make the camera
 * lurch every time an NPC walked behind the player, which reads as a bug even
 * though it is technically "collision".
 */
const CAMERA_PROBE_LAYERS: CollisionLayers = Object.freeze({ staticGeometry: true });

/** {@link CAMERA_PROBE_LAYERS} as the physics module's bitmask, computed once. */
const CAMERA_PROBE_MASK = layerBits(CAMERA_PROBE_LAYERS);

/** `TRANSFORM_FLAGS.TELEPORT`, hoisted out of the per-row loop. */
const FLAG_TELEPORT = TRANSFORM_FLAGS.TELEPORT;

/** `TRANSFORM_FLAGS.VISIBLE`, hoisted out of the per-row loop. */
const FLAG_VISIBLE = TRANSFORM_FLAGS.VISIBLE;

/** The three lane bits of `TRANSFORM_FLAGS`, hoisted for the host-row path. */
const FLAG_POSITION = TRANSFORM_FLAGS.POSITION;
const FLAG_ROTATION = TRANSFORM_FLAGS.ROTATION;
const FLAG_SCALE = TRANSFORM_FLAGS.SCALE;

/**
 * Fraction of the base colour placeholders emit.
 *
 * A scaffold does not necessarily have lights yet, and a black silhouette
 * reads as "broken" rather than as "no lights". Emitting a quarter of the
 * albedo makes a placeholder legible unlit and barely changes it lit.
 */
const PLACEHOLDER_EMISSIVE = 0.25;

/** Options accepted by {@link createEngineAdapter}; `localPlayer` and `send` are on the base. */
export interface EngineAdapterOptions extends PlayerCommandOptions {
  /**
   * The module instances handed to `createEngine`.
   *
   * Services are normally reached through `engine.get(id)`, but the audio
   * decoder is only on the module object: `decodeAsset`, which turns a
   * `play-sound` asset handle into an `AudioBuffer`, and the optional
   * `decodedAsset`, which answers synchronously for a buffer that is already
   * decoded and so lets a sound start on the frame it was asked for. Pass the
   * same array you passed to `createEngine` and both are found automatically.
   */
  modules?: readonly EngineModule[];
  /**
   * HUD renderer. Defaults to {@link createDomHud} over `document.body`; pass
   * your own to restyle it, or `false` to render no HUD at all and read
   * `adapter.hudModel` yourself.
   */
  hud?: HudRenderer | false;
  /** Container for the default HUD. Defaults to `document.body`. */
  hudContainer?: HudElement;
  /** Entity slots reserved up front. Defaults to 512. */
  capacity?: number;
  /**
   * Body-id slots reserved for the body-to-entity table. Defaults to 4096.
   *
   * The table is a `Uint32Array` indexed by body id, so
   * {@link EngineAdapterHandle.entityOfBody} is an array read rather than a
   * `Map` lookup — it runs once per contact and once per raycast hit. Guest
   * body ids are minted in order and never reused, so a long session walks
   * past any fixed ceiling; the table doubles when it has to and warns once,
   * naming this option.
   */
  maxBodies?: number;
  /**
   * When to draw a placeholder mesh in place of a real asset.
   *
   * - `bodies` (the default) — an entity with no renderable gets a mesh the
   *   shape and size of its physics body, and a spawn whose asset is unknown
   *   or not yet resident gets a unit box until the bytes arrive.
   * - `always` — additionally, an entity with neither an asset nor a body gets
   *   a unit box. The right choice for a sketch, where nothing has an asset
   *   yet and an empty scene is indistinguishable from a broken one.
   * - `never` — draw only what the manifest provides. The right choice once
   *   the game has real content, because then a missing mesh is a bug and
   *   should look like one.
   */
  placeholders?: 'bodies' | 'always' | 'never';
  /**
   * Renders the `spawn-character` family for real.
   *
   * Build one with `createCharacterBridge` from
   * `gameable/host/characters` — the optional module, so a game with no
   * characters never downloads the rig stack. Leave it out and the six
   * character commands are recorded on {@link EngineAdapterHandle.animationOf}
   * and warn once, which is what shipped before this existed.
   */
  characters?: CharacterBridge;
  /** Optional structural interview command sink. No integration is loaded by default. */
  conversation?: EngineAdapter['conversation'];
  /**
   * Where warnings go. Defaults to `console.warn`, once per distinct message.
   *
   * @param message What went wrong.
   */
  warn?: (message: string) => void;
}

/** The audio module's `decodeAsset`, the one thing not on the audio service. */
interface AudioDecoder {
  /**
   * Decode the bytes behind an asset id or handle.
   *
   * @param idOrHandle Manifest asset id, or the handle the guest minted.
   * @returns The decoded buffer.
   */
  decodeAsset(idOrHandle: string | number): Promise<AudioBuffer>;
  /**
   * The already-decoded buffer for an asset, when there is one.
   *
   * Optional, and duck-typed: a module that has it lets `play-sound` start a
   * sound in the same turn the guest asked for it, which is the difference
   * between a gunshot on the frame the trigger was pulled and one a microtask
   * later. A module without it falls back to
   * {@link AudioDecoder.decodeAsset}.
   *
   * @param idOrHandle Manifest asset id, or the handle the guest minted.
   * @returns The buffer, or undefined when it is not decoded yet.
   */
  decodedAsset?(idOrHandle: string | number): AudioBuffer | undefined;
}

/**
 * What the adapter remembers about one entity's animation intent.
 *
 * This is the *intent*, recorded whether or not anything draws it. With a
 * {@link EngineAdapterOptions.characters} bridge attached, the same commands
 * also drive a real animator and rig; without one they draw nothing and the
 * entity keeps the placeholder capsule its physics body earned. Either way the
 * record is the cheapest way for a test to prove that a game's locomotion state
 * machine is actually running, which is why it survived the bridge landing. It
 * is published through {@link EngineAdapterHandle.animationOf}.
 */
export interface CharacterAnimationState {
  /** Bundle handle the last `spawn-character` named, or 0. */
  bundle: AssetId;
  /** Locomotion state from the last `set-character-state`. */
  state: string;
  /** World-space velocity from the last `set-character-state`. */
  readonly velocity: Vec3;
  /** Grounded flag from the last `set-character-state`. */
  grounded: boolean;
  /** Clip name from the last `set-anim`, or `''`. */
  clip: string;
  /** Whether that clip was asked to loop. */
  looping: boolean;
  /** Playback rate that clip was asked for. */
  speed: number;
  /** Layer weight that clip was asked for. */
  weight: number;
}

/** The engine-backed adapter, plus the hooks the host loop drives. */
export interface EngineAdapterHandle extends EngineAdapter {
  /** Previous/current transforms, slot `0` being the camera. */
  readonly transforms: TransformStore;
  /** The HUD renderer, or `null` when `hud: false`. */
  readonly hud: HudRenderer | null;
  /** The HUD model currently on screen, whether or not a renderer is attached. */
  readonly hudModel: unknown;
  /** Host-side occurrences since the loop last drained them. */
  readonly events: GameEvent[];

  /**
   * The entity a body id drives.
   *
   * @param body Body id minted by the guest.
   * @returns The entity, or `0` when the body is unknown.
   */
  entityOfBody(body: BodyId): Entity;

  /**
   * Write post-step body rows straight onto the entities they drive.
   *
   * The host half of "physics owns body transforms": the physics module hands
   * these rows over the moment it has stepped, and each one becomes the
   * driven entity's current position and rotation in the transform store. The
   * entity's **scale is left alone** — a body has none, and the guest's is the
   * only opinion there is.
   *
   * Nothing crosses the wasm boundary here. The guest still receives the same
   * rows as `frame-input.bodies` on its next tick and still keeps `Transform`
   * and `Velocity` up to date for gameplay; it simply no longer has to send
   * twelve floats per body back for the host to apply a second time.
   *
   * @param rows Stride-15 rows, as `PhysicsWorld.readBodies` writes them.
   * @param count Rows to read; `rows` may be longer.
   * @returns Nothing.
   */
  applyBodyRows(rows: Float32Array, count: number): void;

  /**
   * Write one transform the host, not the guest, authored: a multiplayer
   * client's replicated row from the authority.
   *
   * Only the lanes `flags` names are written (`TRANSFORM_FLAGS.POSITION`,
   * `ROTATION`, `SCALE`); the others keep their current values. `TELEPORT`
   * snaps instead of interpolating, and `VISIBLE` shows an entity that was
   * hidden at spawn. Unlike `applyTransforms`, a rotation written here is not
   * guest intent, so it never outranks a later physics row. An unknown
   * entity is ignored.
   *
   * @param entity The entity.
   * @param flags `TRANSFORM_FLAGS` bits; the multiplayer `RowFlag` bits are the same values.
   * @param position Position xyz, read when `POSITION` is set.
   * @param rotation Quaternion xyzw, read when `ROTATION` is set.
   * @param scale Scale xyz, read when `SCALE` is set.
   * @returns Nothing.
   */
  setTransformFromHost(
    entity: Entity,
    flags: number,
    position: ArrayLike<number>,
    rotation: ArrayLike<number>,
    scale: ArrayLike<number>,
  ): void;

  /**
   * What the guest last asked an entity's animation to do.
   *
   * @param entity The entity.
   * @returns The recorded intent, or `null` when the entity has never been the
   *   subject of a `spawn-character`, `set-anim` or `set-character-state`.
   */
  animationOf(entity: Entity): CharacterAnimationState | null;

  /**
   * Roll current transforms into previous ones.
   *
   * Call once per fixed step, **before** applying that step's output.
   *
   * @returns Nothing.
   */
  beginFixedStep(): void;

  /**
   * Write the blend of the previous and current transforms onto the scene.
   *
   * @param alpha Interpolation factor in `[0, 1)`, from the engine loop.
   * @returns Nothing.
   */
  interpolate(alpha: number): void;

  /**
   * One rendered frame's worth of adapter work: {@link interpolate}, then the
   * character bridge's animators and rigs.
   *
   * The two are separate because interpolation is pure transform maths and
   * characters are not: a rig runs a compute pass and wants wall-clock seconds,
   * not an interpolation factor.
   *
   * @param dt Clamped wall-clock seconds since the previous frame.
   * @param alpha Interpolation factor in `[0, 1)`, from the engine loop.
   * @returns Nothing.
   */
  update(dt: number, alpha: number): void;

  /** Release the HUD and every object this adapter put in the scene. */
  dispose(): void;
}

/**
 * Does this subtree contain a `SkinnedMesh`?
 *
 * Duck-typed rather than `instanceof`, because an asset loaded by a different
 * copy of three would fail the class check and pass this one.
 *
 * @param root The object to search.
 *
 * @returns True when at least one descendant is skinned.
 */
function hasSkinnedMesh(root: Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if ((node as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) found = true;
  });
  return found;
}

/**
 * How far BELOW an entity's origin its feet are, in metres.
 *
 * `spawn-entity` states a position and `add-body` states a shape around it, and
 * physics puts that shape's CENTRE there. A capsule of radius `x` and half
 * height `y` therefore has its lowest point `x + y` below the entity — the 1.15
 * m the third-person hero's `HERO_CENTRE` spells out by hand. A skinned
 * character's own origin is between its feet, so the bridge adds this to the
 * holder and the body lands on the floor rather than hovering.
 *
 * The sign is negative, so a caller never has to remember which way it goes.
 *
 * @param kind The physics shape kind, or `'unknown'` for a shape with no Jolt
 *   equivalent.
 * @param half The WIT half-extents record.
 *
 * @returns Metres to add to a visual's `y`; 0 when the shape says nothing.
 */
function groundOffsetOf(kind: JoltShapeKind | 'unknown', half: Vec3): number {
  switch (kind) {
    case 'capsule':
    case 'cylinder':
      // Lane order is `[radius, halfHeight]`; a capsule's cap adds the radius.
      return -(half.x + half.y);
    case 'sphere':
      return -half.x;
    case 'box':
      return -half.y;
    default:
      // A mesh, a convex hull or a shape Jolt does not know: its origin is
      // wherever the author put it, so guessing would be worse than zero.
      return 0;
  }
}

/**
 * Everything the adapter keeps per entity.
 */
interface EntityRecord {
  /** Last fixed step with an explicitly guest-authored visual rotation. */
  rotationStep: number;
  /** The group the entity's visual hangs off. */
  readonly root: Group;
  /** The current visual child, or null when the entity draws nothing. */
  visual: Object3D | null;
  /** True when `visual` is a placeholder that a real asset should replace. */
  placeholder: boolean;
  /** Material cloned for this entity by `set-material-param`, to be disposed. */
  ownMaterial: Material | null;
  /** The asset handle the entity wants, or 0. */
  asset: AssetId;
  /** Body id driving the entity, or 0. */
  body: BodyId;
  /**
   * Metres from the entity's origin down to the floor, as a signed offset.
   *
   * An entity's transform is its physics body's CENTRE — roughly a capsule's
   * navel — but a skinned body's own origin is between its feet. The offset is
   * negative, and adding it to the character holder's `y` is what puts the feet
   * on the ground instead of a metre above it. Zero until an `add-body` says
   * what shape the entity is.
   */
  groundOffset: number;
}

/**
 * Build the adapter that applies `frame-output` to a booted engine.
 *
 * @param engine The engine from `createEngine`.
 * @param options Modules, HUD and capacity.
 * @returns An adapter, plus the per-frame hooks {@link createHostLoop} drives.
 *
 * @example
 * ```ts
 * import { createEngine } from 'gameable/core';
 * import { createEngineAdapter } from 'gameable/host';
 *
 * const modules = [physics(), input(), audio(), splat()];
 * const engine = await createEngine({ canvas, manifest, modules });
 * const adapter = createEngineAdapter(engine, { modules });
 * ```
 */
export function createEngineAdapter(
  engine: Engine,
  options: EngineAdapterOptions = {},
): EngineAdapterHandle {
  const transforms = new TransformStore(options.capacity ?? 512);
  const records = new Map<Entity, EntityRecord>();
  /** Live entity ids, so `interpolate` iterates an array and not an iterator. */
  const live: Entity[] = [];
  /** `records.get(live[i])`, kept in step, so `interpolate` never hashes. */
  const liveRecords: EntityRecord[] = [];
  /**
   * Entity per body id, indexed by the id itself.
   *
   * Slot 0 is never a body, so 0 doubles as "no such body" — which is exactly
   * what {@link EngineAdapterHandle.entityOfBody} promises to return.
   */
  let bodyToEntity = new Uint32Array(Math.max(1, options.maxBodies ?? 4096));
  const animations = new Map<Entity, CharacterAnimationState>();
  const events: GameEvent[] = [];
  const warned = new Set<string>();

  const warnSink =
    options.warn ??
    ((message: string): void => {
      console.warn(message);
    });

  /**
   * Warn once per key, building the message only the first time.
   *
   * Several of these sit on the per-frame path — a `set-anim` with no animator,
   * a character command with no bridge — where the message is a template
   * literal over entity ids and clip names. Keying on a short constant and
   * deferring the concatenation means the second and every later frame cost a
   * set lookup and nothing else.
   *
   * @param key What is being warned about. Deduped on this, never on the text.
   * @param build Builds the message. Omit it when `key` is the message.
   * @returns Nothing.
   */
  function warn(key: string, build?: () => string): void {
    if (warned.has(key)) return;
    warned.add(key);
    warnSink(build === undefined ? key : build());
  }

  /**
   * Record which entity a body drives, growing the table when ids outrun it.
   *
   * @param body Body id minted by the guest.
   * @param entity The entity, or 0 to forget the body.
   * @returns Nothing.
   */
  function mapBody(body: BodyId, entity: Entity): void {
    if (body <= 0) return;
    if (body >= bodyToEntity.length) {
      if (entity === 0) return;
      const ceiling = bodyToEntity.length;
      let size = ceiling;
      while (size <= body) size *= 2;
      const grown = new Uint32Array(size);
      grown.set(bodyToEntity);
      bodyToEntity = grown;
      warn(
        'gameable:maxBodies',
        () =>
          `gameable: body id ${String(body)} is past the adapter's maxBodies ` +
          `(${String(ceiling)}); the body-to-entity table has been grown. Pass a larger ` +
          '`maxBodies` to createEngineAdapter to avoid the copy.',
      );
    }
    bodyToEntity[body] = entity;
  }

  const placeholders = options.placeholders ?? 'bodies';
  const characters = options.characters;

  const hud =
    options.hud === false
      ? null
      : (options.hud ?? createDomHud({ container: options.hudContainer }));

  // Shared placeholder resources. One material and a small geometry cache, so
  // a hundred capsules cost one draw material and one geometry.
  const placeholderMaterial = new MeshStandardNodeMaterial({
    color: PLACEHOLDER_COLOUR,
    roughness: 0.72,
    metalness: 0.04,
  });
  placeholderMaterial.emissive = new Color(PLACEHOLDER_COLOUR).multiplyScalar(PLACEHOLDER_EMISSIVE);
  const geometries = new Map<string, BufferGeometry>();

  let physicsService: PhysicsService | null = null;
  let audioService: AudioEngine | null = null;
  let inputService: InputService | null = null;
  let splatService: SplatService | null = null;
  let audioDecoder: AudioDecoder | null = null;
  let servicesResolved = false;
  /**
   * Whether the resolved modules accept the whole command, worked out once.
   *
   * Both are read on the per-frame path — `move-character` runs every step for
   * every character — and a service cannot be swapped after `resolveServices`,
   * so the answer is settled there and never asked again.
   */
  let physicsTakesMoveOptions = false;
  let audioTakesFade = false;

  // Vectors handed to the physics module. It reads them synchronously and
  // keeps nothing, so three arrays serve every call on the command path.
  const scratch3a: [number, number, number] = [0, 0, 0];
  const scratch3b: [number, number, number] = [0, 0, 0];
  const scratch4: [number, number, number, number] = [0, 0, 0, 0];

  /**
   * The listener pose last handed to the audio module: `xyz` then `xyzw`.
   *
   * `set-listener` arrives every tick whether or not the head moved, and
   * moving an unmoved listener re-ramps three `AudioParam`s per panner.
   * Seeded with `NaN`, which compares equal to nothing, so the very first
   * pose is always delivered however ordinary it is.
   */
  const listenerPose = new Float64Array([NaN, NaN, NaN, NaN, NaN, NaN, NaN]);

  /**
   * Resolve every optional service once, on the first frame.
   *
   * @returns Nothing.
   */
  function resolveServices(): void {
    if (servicesResolved) return;
    servicesResolved = true;
    physicsService = lookup(engine, 'physics') as PhysicsService | null;
    audioService = lookup(engine, 'audio') as AudioEngine | null;
    inputService = lookup(engine, 'input') as InputService | null;
    splatService = lookup(engine, 'splat') as SplatService | null;
    physicsTakesMoveOptions =
      physicsService !== null && arityOf(physicsService, 'moveCharacter') >= EXTENDED_MOVE_ARITY;
    audioTakesFade = audioService !== null && arityOf(audioService, 'stop') >= FADED_STOP_ARITY;
    for (const module of options.modules ?? []) {
      const candidate = module as unknown as Partial<AudioDecoder>;
      if (module.id === 'audio' && typeof candidate.decodeAsset === 'function') {
        audioDecoder = candidate as AudioDecoder;
      }
    }
  }

  /**
   * The physics service, or null with one warning per command.
   *
   * @param what The command that wanted it.
   * @returns The service, or null.
   */
  function needPhysics(what: string): PhysicsService | null {
    resolveServices();
    if (physicsService === null) {
      warn(
        `physics:${what}`,
        () => `gameable: "${what}" needs the physics module; add physics() to createEngine`,
      );
    }
    return physicsService;
  }

  /**
   * Fetch or build a shared placeholder geometry.
   *
   * @param kind Physics shape kind the placeholder stands in for.
   * @param a Lane 0: half extent or radius.
   * @param b Lane 1: half extent or half height.
   * @param c Lane 2: half extent.
   * @returns A cached geometry.
   */
  function placeholderGeometry(
    kind: JoltShapeKind | 'unknown',
    a: number,
    b: number,
    c: number,
  ): BufferGeometry {
    const key = `${kind}:${a.toFixed(3)}:${b.toFixed(3)}:${c.toFixed(3)}`;
    const cached = geometries.get(key);
    if (cached) return cached;
    let geometry: BufferGeometry;
    switch (kind) {
      case 'sphere':
        geometry = new SphereGeometry(a, 20, 14);
        break;
      case 'capsule':
      case 'cylinder':
        // Jolt's lane 1 is the half height of the *cylindrical* section, which
        // is exactly what three's `CapsuleGeometry` calls `height`, halved.
        geometry = new CapsuleGeometry(a, b * 2, 6, 16);
        break;
      default:
        geometry = new BoxGeometry(a * 2, b * 2, c * 2);
        break;
    }
    geometries.set(key, geometry);
    return geometry;
  }

  /**
   * Replace an entity's visual.
   *
   * @param record The entity record.
   * @param next The new visual, or null to draw nothing.
   * @param isPlaceholder Whether `next` is a stand-in for a real asset.
   * @returns Nothing.
   */
  function setVisual(record: EntityRecord, next: Object3D | null, isPlaceholder: boolean): void {
    if (record.visual !== null) {
      record.visual.removeFromParent();
      if (record.ownMaterial !== null) {
        record.ownMaterial.dispose();
        record.ownMaterial = null;
      }
    }
    record.visual = next;
    record.placeholder = isPlaceholder;
    if (next !== null) record.root.add(next);
  }

  /**
   * Give an entity a placeholder mesh sized from its physics shape.
   *
   * @param record The entity record.
   * @param kind Shape kind, or `'unknown'` for a unit box.
   * @param a Lane 0.
   * @param b Lane 1.
   * @param c Lane 2.
   * @returns Nothing.
   */
  function addPlaceholder(
    record: EntityRecord,
    kind: JoltShapeKind | 'unknown',
    a: number,
    b: number,
    c: number,
  ): void {
    const mesh = new Mesh(placeholderGeometry(kind, a, b, c), placeholderMaterial);
    mesh.name = 'aos:placeholder';
    setVisual(record, mesh, true);
  }

  /**
   * Build the scene object for a loaded asset, when one can be built.
   *
   * @param name Manifest string id.
   * @param type Manifest asset type.
   * @returns The object, or null when the asset is not resident or not visual.
   */
  function buildAssetObject(name: string, type: string): Object3D | null {
    if (type === 'splat') {
      resolveServices();
      if (splatService === null) {
        warn('gameable: a splat asset was spawned but splat() is not registered');
        return null;
      }
      if (!splatService.loaded.has(name)) return null;
      // `add` parents into the scene; the graph wants it under the entity.
      const object = splatService.add(name) as unknown as Object3D;
      object.removeFromParent();
      return object;
    }
    if (type === 'gltf') {
      const loaded = engine.assets.get(name) as { scene?: Object3D } | undefined;
      const scene = loaded?.scene;
      if (!scene) return null;
      // `Object3D.clone` copies the bones and the skinned meshes independently,
      // so the copy's `SkinnedMesh.skeleton` still points at the ORIGINAL
      // bones: every clone animates the first one. `SkeletonUtils.clone` is the
      // fix, and the character bridge already does it for `backend: 'skinned'`.
      if (hasSkinnedMesh(scene)) {
        warn(
          `skinned:${name}`,
          () =>
            `gameable: gltf asset "${name}" has a skinned mesh; spawning it as a plain model ` +
            'shares one skeleton across every copy. Declare it as a character with ' +
            '`rig: { backend: "skinned" }` and spawn it with `spawn-character` instead.',
        );
      }
      return scene.clone(true);
    }
    return null;
  }

  /**
   * Attach the asset an entity wants, loading it when it is not resident.
   *
   * @param entity The entity.
   * @param asset The asset handle, or 0 for "no renderable".
   * @returns Nothing.
   */
  function attachAsset(entity: Entity, asset: AssetId): void {
    const record = records.get(entity);
    if (record === undefined) return;
    record.asset = asset;
    if (asset === 0) {
      setVisual(record, null, false);
      return;
    }

    const name = engine.assets.idOf(asset);
    const entry = name === undefined ? undefined : engine.assets.entry(name);
    if (name === undefined || entry === undefined) {
      warn(
        `unknown-asset:${String(asset)}`,
        () => `gameable: asset handle ${String(asset)} is not in the manifest`,
      );
      if (record.visual === null && placeholders !== 'never') {
        addPlaceholder(record, 'unknown', 0.5, 0.5, 0.5);
      }
      return;
    }

    const built = buildAssetObject(name, entry.type);
    if (built !== null) {
      setVisual(record, built, false);
      return;
    }
    if (entry.type !== 'splat' && entry.type !== 'gltf') return;

    // Not resident: draw something now, swap when the bytes arrive.
    if (record.visual === null && placeholders !== 'never') {
      addPlaceholder(record, 'unknown', 0.5, 0.5, 0.5);
    }
    void engine.assets
      .load(name)
      .then(() => {
        events.push({ tag: 'asset-loaded', val: { asset, name } });
        const still = records.get(entity);
        if (still === undefined || still.asset !== asset) return;
        const object = buildAssetObject(name, entry.type);
        if (object !== null) setVisual(still, object, false);
      })
      .catch((cause: unknown) => {
        warn(
          `asset-load:${name}`,
          () => `gameable: asset "${name}" failed to load: ${String(cause)}`,
        );
      });
  }

  /**
   * Where the camera is looking, copied out of the guest's `camera-state`.
   *
   * The guest's own record is a pooled object it rewrites next tick, so the
   * value is copied into this scratch rather than retained. `cameraHasTarget`
   * says whether the copy means anything this frame.
   */
  const cameraTarget: Vec3 = { x: 0, y: 0, z: 0 };
  let cameraHasTarget = false;
  let cameraFov = engine.camera.fov;
  let cameraNear = engine.camera.near;
  let cameraFar = engine.camera.far;
  /** Entity hidden because the camera sits inside it. */
  let hiddenByCamera: Entity = 0;

  /** The spring arm, built on the first third-person frame and kept. */
  let springArm: ThirdPersonRig | null = null;
  /**
   * The camera the spring arm drives.
   *
   * Not `engine.camera`: the rig runs during the fixed step and the engine
   * camera is written by `interpolate`, at render rate. The rig's answer is
   * copied into the camera's transform slot instead, so a third-person camera
   * is interpolated between fixed steps exactly like everything else.
   */
  const armCamera = new PerspectiveCamera();
  /** Reused orbit target and angle pair; the rig must not allocate per frame. */
  const armTarget: Vec3 = { x: 0, y: 0, z: 0 };
  const armAngles: LookAngles = { yaw: 0, pitch: 0 };
  const armPosition = new Float32Array(3);

  /**
   * How far the ray from the orbit pivot towards the camera gets.
   *
   * @param from The orbit pivot.
   * @param to Where the camera would like to sit.
   * @returns Distance to the first hit in metres, or null for a clear line.
   */
  const cameraProbe: CollisionProbe = (from, to) => {
    const world = physicsService;
    if (world === null) return null;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length <= 0) return null;
    scratch3a[0] = from.x;
    scratch3a[1] = from.y;
    scratch3a[2] = from.z;
    scratch3b[0] = dx / length;
    scratch3b[1] = dy / length;
    scratch3b[2] = dz / length;
    const found = world.raycast(scratch3a, scratch3b, length, CAMERA_PROBE_MASK);
    return found === null ? null : found.distance;
  };

  /**
   * Point the spring arm at the entity the guest asked to follow.
   *
   * @param camera The camera record for this frame.
   * @param follow The entity being followed; never 0 here.
   * @returns Nothing; {@link armCamera} holds the result.
   */
  function driveSpringArm(camera: CameraState, follow: Entity): void {
    resolveServices();
    springArm ??= createThirdPersonRig({ camera: armCamera, collisionProbe: cameraProbe });

    if (transforms.has(follow)) {
      transforms.getPosition(follow, armPosition);
      armTarget.x = armPosition[0];
      armTarget.y = armPosition[1];
      armTarget.z = armPosition[2];
    } else {
      // The entity has no slot yet — the guest spawned it this very frame. Its
      // own idea of where the pivot is, minus the offset, is the best answer.
      armTarget.x = camera.position.x;
      armTarget.y = camera.position.y - camera.offset.y;
      armTarget.z = camera.position.z;
    }

    lookAngles(camera.rotation, armAngles);
    springArm.pivotHeight = camera.offset.y;
    // One probe per frame: `setTargetAndOrbit` takes both halves and applies
    // them together, where `setTarget` then `setOrbit` would cast twice.
    // The rig's pitch is measured from the pivot towards the camera, so it is
    // the negative of the direction the player is looking.
    springArm.setTargetAndOrbit(armTarget, armAngles.yaw, -armAngles.pitch, camera.armLength);
  }

  /**
   * The animation record for an entity, created on first mention.
   *
   * @param entity The entity a character command named.
   * @returns Its record.
   */
  function animationRecord(entity: Entity): CharacterAnimationState {
    let record = animations.get(entity);
    if (record === undefined) {
      record = {
        bundle: 0,
        state: 'idle',
        velocity: { x: 0, y: 0, z: 0 },
        grounded: true,
        clip: '',
        looping: true,
        speed: 1,
        weight: 1,
      };
      animations.set(entity, record);
    }
    return record;
  }

  /**
   * Destroy an entity and everything hanging off it.
   *
   * @param entity The entity.
   * @returns Nothing.
   */
  function destroy(entity: Entity): void {
    const record = records.get(entity);
    if (record === undefined) return;
    setVisual(record, null, false);
    characters?.despawn(entity);
    engine.graph.despawn(entity);
    records.delete(entity);
    animations.delete(entity);
    const index = live.indexOf(entity);
    if (index >= 0) {
      live.splice(index, 1);
      liveRecords.splice(index, 1);
    }
    transforms.clear(entity);
    if (record.body !== 0) mapBody(record.body, 0);
    if (hiddenByCamera === entity) hiddenByCamera = 0;
  }

  let fixedStep = 0;

  const players = new PlayerCommands(options, warn);
  const adapter: EngineAdapterHandle = {
    appliesLocal: true,
    transforms,
    hud,
    events,

    get hudModel() {
      return hud?.model ?? null;
    },

    entityOfBody(body) {
      return body > 0 && body < bodyToEntity.length ? bodyToEntity[body] : 0;
    },

    applyBodyRows(rows, count) {
      const limit = Math.min(count, Math.floor(rows.length / BODY_STRIDE));
      for (let row = 0; row < limit; row += 1) {
        const o = row * BODY_STRIDE;
        const body = rows[o] | 0;
        if (body <= 0 || body >= bodyToEntity.length) continue;
        const entity = bodyToEntity[body];
        if (entity === 0) continue;
        // Position and rotation only: the two stores compare before they
        // store, so a body asleep on a shelf costs ten float comparisons and
        // dirties nothing.
        transforms.setPosition(entity, rows[o + 1], rows[o + 2], rows[o + 3]);
        // A visual turn sent this tick must survive the later physics step.
        // Position still follows physics; un-authored rotations do too.
        if (records.get(entity)?.rotationStep !== fixedStep)
          transforms.setQuaternion(entity, rows[o + 4], rows[o + 5], rows[o + 6], rows[o + 7]);
      }
    },

    setTransformFromHost(entity, flags, position, rotation, scale) {
      const record = records.get(entity);
      if (record === undefined) return;
      if ((flags & FLAG_POSITION) !== 0) transforms.setPosition(entity, position[0], position[1], position[2]);
      if ((flags & FLAG_ROTATION) !== 0) {
        transforms.setQuaternion(entity, rotation[0], rotation[1], rotation[2], rotation[3]);
      }
      if ((flags & FLAG_SCALE) !== 0) transforms.setScale(entity, scale[0], scale[1], scale[2]);
      if ((flags & FLAG_TELEPORT) !== 0) transforms.snap(entity);
      if ((flags & FLAG_VISIBLE) !== 0 && entity !== hiddenByCamera) record.root.visible = true;
    },

    animationOf(entity) {
      return animations.get(entity) ?? null;
    },

    beginFixedStep() {
      fixedStep += 1;
      transforms.commit();
      players.beginStep();
    },

    interpolate(alpha) {
      // `liveRecords[i]` is `records.get(live[i])`, kept in step by spawn and
      // destroy: this loop runs once per entity per rendered frame, and a hash
      // lookup there is the difference between a scan and a scan plus 5,000
      // map probes.
      for (let i = 0; i < live.length; i += 1) {
        transforms.writeInterpolated(live[i], liveRecords[i].root, alpha);
      }
      transforms.writeInterpolated(CAMERA_SLOT, engine.camera, alpha);
      if (cameraHasTarget) {
        engine.camera.lookAt(cameraTarget.x, cameraTarget.y, cameraTarget.z);
      }
    },

    update(dt, alpha) {
      adapter.interpolate(alpha);
      // After interpolation, so a head that aims at a moving target aims at
      // where that target is being drawn this frame rather than a step behind.
      characters?.update(dt);
    },

    // -- scene ---------------------------------------------------------------

    spawn(entity, asset, position, rotation, scale, flags) {
      if (records.has(entity)) destroy(entity);
      const root = new Group();
      root.name = flags.name ?? `entity:${String(entity)}`;
      root.position.set(position.x, position.y, position.z);
      root.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      root.scale.set(scale.x, scale.y, scale.z);
      root.visible = flags.visible;
      engine.graph.spawn(entity, root, flags.parent ?? 0);

      const record: EntityRecord = {
        rotationStep: -1,
        root,
        visual: null,
        placeholder: false,
        ownMaterial: null,
        asset: 0,
        body: 0,
        groundOffset: 0,
      };
      records.set(entity, record);
      live.push(entity);
      liveRecords.push(record);

      transforms.set(
        entity,
        position.x,
        position.y,
        position.z,
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w,
        scale.x,
        scale.y,
        scale.z,
      );
      transforms.snap(entity);

      if (asset !== undefined) attachAsset(entity, asset);
      else if (placeholders === 'always') addPlaceholder(record, 'unknown', 0.5, 0.5, 0.5);
    },

    despawn(entity) {
      destroy(entity);
    },

    setAsset(entity, asset) {
      attachAsset(entity, asset ?? 0);
    },

    setParent(entity, parent, keepWorldTransform) {
      const record = records.get(entity);
      if (record === undefined) return;
      if (keepWorldTransform) {
        // `attach` preserves the world matrix; the graph only tracks ids.
        record.root.updateWorldMatrix(true, false);
      }
      engine.graph.setParent(entity, parent ?? 0);
    },

    setAnim(entity, clip, looping, speed, _fadeMs, weight) {
      const record = animationRecord(entity);
      record.clip = clip;
      record.looping = looping;
      record.speed = speed;
      record.weight = weight;
      // Keyed on the command, not the clip: a locomotion state machine emits
      // one of these every step, and building the message each time would be
      // the most expensive thing on a frame that does nothing.
      warn(
        'set-anim',
        () =>
          `gameable: set-anim("${clip}") on entity ${String(entity)} draws nothing yet; ` +
          'animation lands with @gameable/animation. The request is recorded on ' +
          'adapter.animationOf(entity).',
      );
    },

    setMaterialParam(entity, name, value) {
      const record = records.get(entity);
      const visual = record?.visual;
      if (!visual) {
        // A character has replaced the placeholder, so there is no mesh here to
        // tint — but the bridge owns one and can. This is what keeps the FPS
        // template's red enemies red once they are real bodies.
        characters?.setMaterialParam?.(entity, name, value);
        return;
      }
      const mesh = visual as Partial<Mesh>;
      if (!mesh.material) return;
      if (record.ownMaterial === null) {
        // The placeholder material is shared; tinting one entity must not
        // repaint every other capsule in the level.
        const clone = (mesh.material as Material).clone();
        record.ownMaterial = clone;
        (visual as Mesh).material = clone;
      }
      applyMaterialParam(record.ownMaterial, name, value, warn);
    },

    // -- physics -------------------------------------------------------------

    addBody(args) {
      mapBody(args.body, args.entity);
      const record = records.get(args.entity);
      if (record !== undefined) record.body = args.body;

      const kind = shapeKind(args.shape.kind);
      if (record !== undefined) {
        record.groundOffset = groundOffsetOf(kind ?? 'unknown', args.shape.halfExtents);
      }
      if (
        record !== undefined &&
        placeholders !== 'never' &&
        (record.visual === null || record.placeholder)
      ) {
        addPlaceholder(
          record,
          kind ?? 'unknown',
          args.shape.halfExtents.x,
          args.shape.halfExtents.y,
          args.shape.halfExtents.z,
        );
      }

      const world = needPhysics('add-body');
      if (world === null) return;
      if (!isGuestShape(kind)) {
        const skip = addBodySkip(args.shape.kind, kind);
        warn(skip.key, skip.message);
        return;
      }
      try {
        world.addBody(toJoltBody(args, kind));
      } catch (cause) {
        warn(
          `add-body:${String(args.body)}`,
          () => `gameable: add-body ${String(args.body)} failed: ${String(cause)}`,
        );
      }
    },

    removeBody(body) {
      mapBody(body, 0);
      needPhysics('remove-body')?.removeBody(body);
    },

    setBodyTransform(body, position, rotation, teleport) {
      const world = needPhysics('set-body-transform');
      if (world === null) return;
      scratch3a[0] = position.x;
      scratch3a[1] = position.y;
      scratch3a[2] = position.z;
      scratch4[0] = rotation.x;
      scratch4[1] = rotation.y;
      scratch4[2] = rotation.z;
      scratch4[3] = rotation.w;
      world.setTransform(body, scratch3a, scratch4, teleport);
      if (teleport) {
        // A teleport that only moved the body would still be interpolated: the
        // entity's own slot has to forget where it came from too, or the visual
        // slides across the level over the next frame.
        const entity = body > 0 && body < bodyToEntity.length ? bodyToEntity[body] : 0;
        if (entity !== 0 && transforms.has(entity)) transforms.snap(entity);
      }
    },

    setBodyVelocity(body, linear, angular) {
      const world = needPhysics('set-body-velocity');
      if (world === null) return;
      scratch3a[0] = linear?.x ?? 0;
      scratch3a[1] = linear?.y ?? 0;
      scratch3a[2] = linear?.z ?? 0;
      scratch3b[0] = angular?.x ?? 0;
      scratch3b[1] = angular?.y ?? 0;
      scratch3b[2] = angular?.z ?? 0;
      world.setVelocity(body, scratch3a, scratch3b);
    },

    applyImpulse(body, impulse, atPoint) {
      const world = needPhysics('apply-impulse');
      if (world === null) return;
      scratch3a[0] = impulse.x;
      scratch3a[1] = impulse.y;
      scratch3a[2] = impulse.z;
      if (atPoint) {
        scratch3b[0] = atPoint.x;
        scratch3b[1] = atPoint.y;
        scratch3b[2] = atPoint.z;
        world.applyImpulse(body, scratch3a, scratch3b);
      } else {
        world.applyImpulse(body, scratch3a);
      }
    },

    setBodyEnabled(body, enabled) {
      needPhysics('set-body-enabled')?.setEnabled(body, enabled);
    },

    moveCharacter(body, desiredVelocity, jump, crouch, maxSlopeDeg) {
      const world = needPhysics('move-character');
      if (world === null) return;
      scratch3a[0] = desiredVelocity.x;
      scratch3a[1] = jumpSpeed(desiredVelocity.y, jump, world, body);
      scratch3a[2] = desiredVelocity.z;
      if (physicsTakesMoveOptions) {
        (world as unknown as ExtendedPhysics).moveCharacter(body, scratch3a, crouch, maxSlopeDeg);
        return;
      }
      world.moveCharacter(body, scratch3a);
      // Never silently dropped: a game that crouches and sees nothing happen
      // deserves to be told which module owes it the behaviour.
      warnDroppedMoveFields(crouch, maxSlopeDeg, warn);
    },

    // -- characters ----------------------------------------------------------

    spawnCharacter(entity, bundle, position, rotation) {
      animationRecord(entity).bundle = bundle;
      if (characters === undefined) {
        warnCharacter(warn, 'spawn-character', entity);
        return;
      }
      characters.spawn({
        entity,
        bundle,
        parent: records.get(entity)?.root,
        position,
        rotation,
        // The prefab helper emits `add-body` before `spawn-character`, so by
        // the time this runs the record already knows how tall the capsule
        // that stands in for this entity is.
        groundOffset: records.get(entity)?.groundOffset ?? 0,
        // The capsule was the entity's body while there was nothing else to
        // draw. Once a head is on screen it is in the way.
        onAttached: () => {
          const record = records.get(entity);
          if (record !== undefined && record.placeholder) setVisual(record, null, false);
        },
      });
    },
    setCharacterState(entity, state, velocity, grounded) {
      const record = animationRecord(entity);
      record.state = state;
      record.velocity.x = velocity.x;
      record.velocity.y = velocity.y;
      record.velocity.z = velocity.z;
      record.grounded = grounded;
      if (characters === undefined) {
        warnCharacter(warn, 'set-character-state', entity);
        return;
      }
      characters.setState(entity, state, velocity, grounded);
    },
    setClipWeights(entity, clips, weights, timeScale) {
      if (characters === undefined) {
        warnCharacter(warn, 'set-clip-weights', entity);
        return;
      }
      characters.setClipWeights(entity, clips, weights, timeScale);
    },
    setExpression(entity: Entity, space, weights) {
      if (characters === undefined) {
        warnCharacter(warn, 'set-expression', entity);
        return;
      }
      characters.setExpression(entity, space, weights);
    },
    lookAt(entity, target, weight) {
      if (characters === undefined) {
        warnCharacter(warn, 'look-at', entity);
        return;
      }
      characters.lookAt(entity, target, weight);
    },
    conversation(command) {
      if (options.conversation !== undefined) options.conversation(command);
      else warn('gameable: conversation command requires an optional conversation adapter');
    },
    say(entity, text, audio, visemes) {
      if (characters === undefined) {
        warnCharacter(warn, 'say', entity);
        return;
      }
      characters.say(entity, text, audio, visemes);
    },

    // -- audio ---------------------------------------------------------------

    playSound(sound, asset, entity, position, volume, pitch, looping, bus) {
      resolveServices();
      const engineAudio = audioService;
      const decoder = audioDecoder;
      if (engineAudio === null || decoder === null) {
        warn('gameable: play-sound needs the audio module; add audio() to createEngine');
        return;
      }
      if (pitch !== 1) {
        warn('gameable: play-sound pitch is not implemented by @gameable/audio yet');
      }
      // Where the sound is, without building a `Vec3` to say so.
      let positional = false;
      if (position !== undefined) {
        scratch3a[0] = position.x;
        scratch3a[1] = position.y;
        scratch3a[2] = position.z;
        positional = true;
      } else if (entity !== undefined && entity !== 0) {
        const source = records.get(entity);
        if (source !== undefined) {
          const p = source.root.position;
          scratch3a[0] = p.x;
          scratch3a[1] = p.y;
          scratch3a[2] = p.z;
          positional = true;
        }
      }

      // The common case: the buffer is already decoded, so the sound starts on
      // the frame the guest asked for it rather than a microtask later. A
      // gunshot that lags its own muzzle flash is the thing this avoids.
      const ready = decoder.decodedAsset?.(asset);
      if (ready !== undefined) {
        engineAudio.play({
          id: sound,
          buffer: ready,
          pos: positional ? scratch3a : undefined,
          volume,
          loop: looping,
          bus: audioBus(bus),
        });
        return;
      }

      // A miss: the bytes are not decoded yet. The position is captured now
      // because the scratch has moved on by the time the promise settles.
      const px = scratch3a[0];
      const py = scratch3a[1];
      const pz = scratch3a[2];
      decoder
        .decodeAsset(asset)
        .then((buffer) => {
          engineAudio.play({
            id: sound,
            buffer,
            pos: positional ? [px, py, pz] : undefined,
            volume,
            loop: looping,
            bus: audioBus(bus),
          });
        })
        .catch((cause: unknown) => {
          warn(
            `sound-decode:${String(asset)}`,
            () => `gameable: sound asset ${String(asset)} failed to decode: ${String(cause)}`,
          );
        });
    },

    stopSound(sound, fadeMs) {
      resolveServices();
      const service = audioService;
      if (service === null) return;
      if (audioTakesFade) {
        (service as unknown as FadingAudio).stop(sound, fadeMs);
        return;
      }
      service.stop(sound);
      if (fadeMs > 0) {
        warn(
          'gameable: stop-sound fadeMs is not implemented by the audio module; the sound is ' +
            'cut rather than faded',
        );
      }
    },

    setListener(position, rotation, velocity) {
      resolveServices();
      if (velocity.x !== 0 || velocity.y !== 0 || velocity.z !== 0) {
        warn(
          'gameable: set-listener velocity is recorded by the guest but @gameable/audio has ' +
            'no doppler stage, so it changes nothing',
        );
      }
      // The pose is re-sent every tick by a first-person camera that has not
      // moved. Bit-identical means the panner nodes already hold it.
      if (
        position.x === listenerPose[0] &&
        position.y === listenerPose[1] &&
        position.z === listenerPose[2] &&
        rotation.x === listenerPose[3] &&
        rotation.y === listenerPose[4] &&
        rotation.z === listenerPose[5] &&
        rotation.w === listenerPose[6]
      ) {
        return;
      }
      listenerPose[0] = position.x;
      listenerPose[1] = position.y;
      listenerPose[2] = position.z;
      listenerPose[3] = rotation.x;
      listenerPose[4] = rotation.y;
      listenerPose[5] = rotation.z;
      listenerPose[6] = rotation.w;
      scratch3a[0] = position.x;
      scratch3a[1] = position.y;
      scratch3a[2] = position.z;
      scratch4[0] = rotation.x;
      scratch4[1] = rotation.y;
      scratch4[2] = rotation.z;
      scratch4[3] = rotation.w;
      audioService?.setListener(scratch3a, scratch4);
    },

    // -- misc ----------------------------------------------------------------

    /**
     * Start loading an asset.
     *
     * `priority` is advisory and currently ignored: `gameable/assets` has one
     * queue and no scheduler to hand it to, so a high-priority request is
     * started in command order like every other. It is part of the WIT contract
     * so that a future prioritised loader needs no boundary change.
     *
     * @param asset The asset handle.
     * @returns Nothing.
     */
    loadAsset(asset) {
      const name = engine.assets.idOf(asset);
      if (name === undefined) return;
      void engine.assets
        .load(name)
        .then(() => {
          events.push({ tag: 'asset-loaded', val: { asset, name } });
        })
        .catch((cause: unknown) => {
          warn(
            `asset-load:${name}`,
            () => `gameable: asset "${name}" failed to load: ${String(cause)}`,
          );
        });
    },

    setPointerLock(locked) {
      resolveServices();
      if (inputService === null) {
        warn('gameable: set-pointer-lock needs the input module');
        return;
      }
      if (locked) inputService.requestPointerLock();
      else inputService.exitPointerLock();
    },

    setTimeScale(scale) {
      const time = engine.ctx.time as { timeScale: number };
      time.timeScale = scale;
    },

    // send, setPlayerCamera, setPlayerHud and the data commands: `adapter/PlayerCommands.ts`.
    ...players.methods,

    setCamera(camera: CameraState) {
      if (players.ownsCamera) return; // this step's set-player-camera wins
      // A third-person camera states an intent — follow this entity, at this
      // orbit, on a boom this long — and the host owns the arm and its
      // collision. Everything else is an explicit eye transform.
      const follow = camera.follow ?? 0;
      if (camera.mode === 'third-person' && follow !== 0 && camera.armLength > 0) {
        driveSpringArm(camera, follow);
        transforms.set(
          CAMERA_SLOT,
          armCamera.position.x,
          armCamera.position.y,
          armCamera.position.z,
          armCamera.quaternion.x,
          armCamera.quaternion.y,
          armCamera.quaternion.z,
          armCamera.quaternion.w,
          1,
          1,
          1,
        );
      } else {
        transforms.set(
          CAMERA_SLOT,
          camera.position.x,
          camera.position.y,
          camera.position.z,
          camera.rotation.x,
          camera.rotation.y,
          camera.rotation.z,
          camera.rotation.w,
          1,
          1,
          1,
        );
      }
      // Copied, not retained: `camera.target` is a pooled `Vec3` the guest
      // rewrites on its next tick, and `interpolate` reads this at render rate.
      const target = camera.target;
      cameraHasTarget = target !== undefined;
      if (target !== undefined) {
        cameraTarget.x = target.x;
        cameraTarget.y = target.y;
        cameraTarget.z = target.z;
      }

      if (camera.fovYDeg !== cameraFov || camera.near !== cameraNear || camera.far !== cameraFar) {
        cameraFov = camera.fovYDeg;
        cameraNear = camera.near;
        cameraFar = camera.far;
        engine.camera.fov = cameraFov;
        engine.camera.near = cameraNear;
        engine.camera.far = cameraFar;
        engine.camera.updateProjectionMatrix();
      }

      // You do not render the thing your eye is inside.
      const hide = camera.mode === 'first-person' ? (camera.follow ?? 0) : 0;
      if (hide !== hiddenByCamera) {
        const previous = records.get(hiddenByCamera);
        if (previous !== undefined) previous.root.visible = true;
        const next = records.get(hide);
        if (next !== undefined) next.root.visible = false;
        hiddenByCamera = hide;
      }
    },

    setHud(json) {
      if (players.ownsHud) return; // this step's set-player-hud wins
      hud?.set(json);
    },

    /**
     * Apply packed entity transforms.
     *
     * `TRANSFORM_FLAGS.DESTROYED` is not honoured here and never was reachable:
     * the guest despawns through the `despawn` command, and `packing.ts` drops
     * a destroyed entity's row rather than flagging it. A row with the flag set
     * is treated as an ordinary move.
     *
     * @param packed Stride-12 rows: entity, flags, position, rotation, scale.
     * @param count Rows to read; `packed` may be longer.
     * @returns Nothing.
     */
    applyTransforms(packed, count) {
      for (let row = 0; row < count; row += 1) {
        const o = row * TRANSFORM_STRIDE;
        const entity = packed[o] | 0;
        if (entity <= 0) continue;
        const record = records.get(entity);
        if (record === undefined) continue;
        const flags = packed[o + 1] | 0;
        if ((flags & TRANSFORM_FLAGS.ROTATION) !== 0) record.rotationStep = fixedStep;
        transforms.set(
          entity,
          packed[o + 2],
          packed[o + 3],
          packed[o + 4],
          packed[o + 5],
          packed[o + 6],
          packed[o + 7],
          packed[o + 8],
          packed[o + 9],
          packed[o + 10],
          packed[o + 11],
        );
        if ((flags & FLAG_TELEPORT) !== 0) transforms.snap(entity);
        if ((flags & FLAG_VISIBLE) !== 0 && entity !== hiddenByCamera) {
          record.root.visible = true;
        }
      }
    },

    dispose() {
      for (const entity of [...live]) destroy(entity);
      characters?.dispose();
      hud?.dispose();
      for (const geometry of geometries.values()) geometry.dispose();
      geometries.clear();
      placeholderMaterial.dispose();
    },
  };
  players.show(adapter);

  return adapter;
}

/** A yaw/pitch pair in radians, filled in by {@link lookAngles}. */
interface LookAngles {
  /** Yaw about `+Y`. */
  yaw: number;
  /** Pitch above the horizon; positive looks up. */
  pitch: number;
}

/**
 * Decompose a camera rotation into the yaw and pitch it is looking along.
 *
 * The guest states the orbit as a rotation, because that is what
 * `camera-state` carries; the spring arm wants two angles. Rather than assume
 * the quaternion came from the SDK's own `quatFromYawPitch`, the forward axis
 * is rotated and read back, which is true for any rotation a game writes.
 *
 * @param rotation The camera rotation, xyzw.
 * @param out Angles written in place, in radians.
 * @returns Nothing; `out` is mutated.
 */
function lookAngles(rotation: Quat, out: LookAngles): void {
  const { x, y, z, w } = rotation;
  // q * (0, 0, -1): the direction the camera is looking.
  const fx = -2 * (y * w + z * x);
  const fy = 2 * (x * w - y * z);
  const fz = 2 * (x * x + y * y) - 1;
  out.yaw = Math.atan2(-fx, -fz);
  out.pitch = Math.asin(fy < -1 ? -1 : fy > 1 ? 1 : fy);
}

/**
 * Map the WIT audio bus onto the audio module's bus names.
 *
 * @param bus The WIT bus.
 * @returns A bus the audio engine knows; `ui` folds into `sfx`.
 */
function audioBus(bus: AudioBus): BusName {
  return bus === 'ui' ? 'sfx' : bus;
}

/** A deduping warning sink: one message per key, built on demand. */
type WarnSink = (key: string, build?: () => string) => void;

/**
 * Apply one `set-material-param` to a material.
 *
 * @param material The entity's own material clone.
 * @param name Uniform name: `color`, `emissive`, `opacity`, `roughness` or `metalness`.
 * @param value The WIT variant.
 * @param warn Warning sink.
 * @returns Nothing.
 */
function applyMaterialParam(
  material: Material,
  name: string,
  value: MaterialValue,
  warn: WarnSink,
): void {
  const target = material as Material & {
    color?: Color;
    emissive?: Color;
    roughness?: number;
    metalness?: number;
  };
  switch (name) {
    case 'color':
    case 'emissive': {
      if (value.tag !== 'color') {
        warn(`gameable: material param "${name}" wants a color value`);
        return;
      }
      const slot = name === 'color' ? target.color : target.emissive;
      slot?.setRGB(value.val.r, value.val.g, value.val.b);
      if (value.val.a < 1) {
        material.transparent = true;
        material.opacity = value.val.a;
      }
      return;
    }
    case 'opacity':
      if (value.tag !== 'scalar') return;
      material.opacity = value.val;
      material.transparent = value.val < 1;
      return;
    case 'roughness':
      if (value.tag === 'scalar') target.roughness = value.val;
      return;
    case 'metalness':
      if (value.tag === 'scalar') target.metalness = value.val;
      return;
    default:
      warn(`gameable: material param "${name}" is not understood by the placeholder material`);
  }
}

/**
 * One warning for the whole character command family.
 *
 * @param warn Warning sink.
 * @param command The command that was ignored.
 * @param entity The entity it named.
 * @returns Nothing.
 */
function warnCharacter(warn: WarnSink, command: string, entity: Entity): void {
  // Keyed on the command: every entity in a crowd hits this on the same frame,
  // and the message is the same advice however many of them there are.
  warn(
    `character:${command}`,
    () =>
      `gameable: "${command}" (entity ${String(entity)}) is recorded but draws nothing; this ` +
      'adapter has no character bridge. Pass `characters: createCharacterBridge({ engine })` ' +
      'from @gameable/wasm-host/characters. Capsules stand in until then.',
  );
}

/** Options accepted by {@link createEngineHost}: seed, log sink and query capacity. */
export type EngineHostOptions = HostQueriesOptions;

/**
 * Build the `HostApi` a browser sandbox imports.
 *
 * These are the only synchronous calls the guest may make during `tick`: three
 * physics queries and two init-time manifest lookups. Everything else the
 * guest wants is a command, applied after it returns. The queries themselves
 * are `HostQueries`, shared with the server's `createServerHost`; this
 * wrapper only says where the page's physics, bodies and assets come from.
 *
 * Physics is looked up lazily, on the first query that finds it registered,
 * so the host can be built before the engine boots.
 *
 * @param engine The booted engine.
 * @param adapter The adapter, for the body-to-entity mapping queries report.
 * @param options Seed, log sink and query capacity.
 * @returns A `HostApi` to hand to `createSandbox`.
 *
 * @example
 * ```ts
 * import { createEngineAdapter, createEngineHost, createSandbox } from 'gameable/host';
 *
 * const adapter = createEngineAdapter(engine, { modules });
 * const host = createEngineHost(engine, adapter, { seed: 1 });
 * const sandbox = await createSandbox({ mode: 'direct', game, host });
 * ```
 */
export function createEngineHost(
  engine: Engine,
  adapter: EngineAdapterHandle,
  options: EngineHostOptions = {},
): HostApi {
  return new HostQueries(
    () => lookup(engine, 'physics') as PhysicsService | null,
    (body) => adapter.entityOfBody(body),
    engine.assets,
    options,
  );
}

// The host loop, the game slot and the error card moved to `adapter/`; they are
// re-exported here so every existing import of this file keeps working.
export { createGameSlot, type GameSlot } from './adapter/GameSlot';
export { createHostLoop, type HostLoopOptions } from './adapter/HostLoop';
