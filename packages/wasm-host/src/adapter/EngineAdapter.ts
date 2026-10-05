/**
 * The narrow interface the sandbox needs from an engine.
 *
 * `gameable/host` deliberately does **not** import `gameable/core`.
 * Everything `frame-output` can ask for is one method here, and the engine
 * implements the interface; that keeps the boundary testable in node with
 * `NullEngineAdapter` and keeps the dependency arrow pointing one way.
 */
import type {
  AddBodyCmd,
  AssetId,
  AudioBus,
  BodyId,
  CameraState,
  Entity,
  ConversationCmd,
  ExchangeCmd,
  ExpressionSpace,
  MaterialValue,
  Quat,
  SoundId,
  Vec3,
} from '@gameable/sdk';

/** Everything the host can be asked to do, one method per command. */
export interface EngineAdapter {
  /**
   * True when `frame-output.local-commands` are applied here, after
   * `commands`: the page's own adapter and the authority's server adapter. A
   * replica's adapter says false; the replicator never forwards them.
   */
  readonly appliesLocal: boolean;
  /**
   * Optional: told when `applyOutput` starts (`true`) and ends (`false`)
   * applying `frame-output.local-commands`. The server adapter uses it to keep
   * what a local command does out of the replicated world record.
   */
  localScope?(on: boolean): void;
  /** Forward structural controls to an optional conversation module. */
  conversation(command: ConversationCmd): void;
  /** Create an entity in the scene. */
  spawn(
    entity: Entity,
    asset: AssetId | undefined,
    position: Vec3,
    rotation: Quat,
    scale: Vec3,
    flags: { parent?: Entity; visible: boolean; name?: string },
  ): void;
  /** Destroy an entity and everything attached to it. */
  despawn(entity: Entity): void;
  /** Attach or detach a renderable. */
  setAsset(entity: Entity, asset: AssetId | undefined): void;
  /** Reparent an entity. */
  setParent(entity: Entity, parent: Entity | undefined, keepWorldTransform: boolean): void;
  /** Play or cross-fade an animation clip. */
  setAnim(
    entity: Entity,
    clip: string,
    looping: boolean,
    speed: number,
    fadeMs: number,
    weight: number,
  ): void;
  /** Set one material uniform. */
  setMaterialParam(entity: Entity, name: string, value: MaterialValue): void;

  /** Create a rigid body or character controller. */
  addBody(args: AddBodyCmd): void;
  /** Destroy a body. */
  removeBody(body: BodyId): void;
  /** Move a body directly. */
  setBodyTransform(body: BodyId, position: Vec3, rotation: Quat, teleport: boolean): void;
  /** Overwrite a body's velocities; `undefined` leaves one untouched. */
  setBodyVelocity(body: BodyId, linear: Vec3 | undefined, angular: Vec3 | undefined): void;
  /** Apply a one-shot impulse. */
  applyImpulse(body: BodyId, impulse: Vec3, atPoint: Vec3 | undefined): void;
  /** Enable or disable a body in the broad phase. */
  setBodyEnabled(body: BodyId, enabled: boolean): void;
  /** Drive a character body for one step. */
  moveCharacter(
    body: BodyId,
    desiredVelocity: Vec3,
    jump: boolean,
    crouch: boolean,
    maxSlopeDeg: number,
  ): void;

  /** Instantiate a splat character bundle. */
  spawnCharacter(entity: Entity, bundle: AssetId, position: Vec3, rotation: Quat): void;
  /** Drive a character's locomotion state machine. */
  setCharacterState(entity: Entity, state: string, velocity: Vec3, grounded: boolean): void;
  /** Set explicit per-clip weights. */
  setClipWeights(
    entity: Entity,
    clips: readonly string[],
    weights: ArrayLike<number>,
    timeScale: number,
  ): void;
  /** Set facial expression coefficients. */
  setExpression(entity: Entity, space: ExpressionSpace, weights: ArrayLike<number>): void;
  /** Aim a character's head and eyes. */
  lookAt(entity: Entity, target: Vec3 | undefined, weight: number): void;
  /** Speak a line. */
  say(entity: Entity, text: string, audio: AssetId | undefined, visemes: string | undefined): void;

  /** Start a sound. */
  playSound(
    sound: SoundId,
    asset: AssetId,
    entity: Entity | undefined,
    position: Vec3 | undefined,
    volume: number,
    pitch: number,
    looping: boolean,
    bus: AudioBus,
  ): void;
  /** Stop a playing sound. */
  stopSound(sound: SoundId, fadeMs: number): void;
  /** Place the audio listener. */
  setListener(position: Vec3, rotation: Quat, velocity: Vec3): void;

  /** Start loading an asset. */
  loadAsset(asset: AssetId, priority: number): void;
  /** Request or release pointer lock. */
  setPointerLock(locked: boolean): void;
  /** Scale simulated time. */
  setTimeScale(scale: number): void;

  /** Send a game message; `to` undefined is every player (or the authority, from a client). */
  send(to: number | undefined, name: string, payload: string, reliable: boolean): void;
  /** The camera one player renders from. */
  setPlayerCamera(player: number, camera: CameraState): void;
  /** One player's HUD model as JSON. */
  setPlayerHud(player: number, hud: string): void;
  /** Persist one player's document (JSON). */
  savePlayerData(player: number, data: string): void;
  /** Persist the room's game-wide document (JSON). */
  saveGameData(data: string): void;
  /** Trade between two players' documents. The command is pooled: read it, never keep it. */
  exchange(command: ExchangeCmd): void;
  /**
   * Which entity a player controls (0 for none). The authority keeps the
   * mapping for relevancy and each player's "your entity"; a page ignores it.
   */
  setPlayerEntity(player: number, entity: Entity): void;

  /** Apply the camera the guest asked for. */
  setCamera(camera: CameraState): void;
  /** Apply the HUD model, or leave the previous one when `undefined`. */
  setHud(json: string | undefined): void;
  /**
   * Apply packed entity transforms.
   *
   * @param transforms Stride 12: entity, flags, position, rotation, scale.
   * @param count Number of rows. The buffer may be longer.
   */
  applyTransforms(transforms: Float32Array, count: number): void;
}

/** The names of the {@link EngineAdapter} methods: every member but `appliesLocal` and the optional `localScope`. */
export type AdapterMethod = Exclude<keyof EngineAdapter, 'appliesLocal' | 'localScope'>;

/** One recorded `EngineAdapter` call. */
export interface AdapterCall {
  /** Method name. */
  method: AdapterMethod;
  /** Arguments, by reference — they may be pooled and reused by the guest. */
  args: readonly unknown[];
}

/** An adapter that records instead of rendering. */
export interface NullAdapter extends EngineAdapter {
  /** Whether `applyOutput` applies `localCommands` here. True unless the options say otherwise. */
  appliesLocal: boolean;
  /** Every call, in order. */
  readonly calls: AdapterCall[];
  /** Calls with a given method name. */
  by(method: AdapterMethod): AdapterCall[];
  /** Forget every recorded call. */
  reset(): void;
  /** Rows handed to the most recent `applyTransforms`. */
  readonly lastTransformCount: number;
}

/**
 * Every method an adapter must provide, as a table the compiler checks.
 *
 * `Record<AdapterMethod, true>` is the whole point: adding a method to
 * {@link EngineAdapter} without a row here is a missing-property error, and a
 * row for a method that no longer exists is an excess-property error. The
 * runtime list below is then derived from it rather than maintained twice.
 */
const METHOD_TABLE: Record<AdapterMethod, true> = {
  conversation: true,
  spawn: true,
  despawn: true,
  setAsset: true,
  setParent: true,
  setAnim: true,
  setMaterialParam: true,
  addBody: true,
  removeBody: true,
  setBodyTransform: true,
  setBodyVelocity: true,
  applyImpulse: true,
  setBodyEnabled: true,
  moveCharacter: true,
  spawnCharacter: true,
  setCharacterState: true,
  setClipWeights: true,
  setExpression: true,
  lookAt: true,
  say: true,
  playSound: true,
  stopSound: true,
  setListener: true,
  loadAsset: true,
  setPointerLock: true,
  setTimeScale: true,
  send: true,
  setPlayerCamera: true,
  setPlayerHud: true,
  savePlayerData: true,
  saveGameData: true,
  exchange: true,
  setPlayerEntity: true,
  setCamera: true,
  setHud: true,
  applyTransforms: true,
};

/** Method names an adapter must provide, used to build the null adapter. */
const METHODS = Object.keys(METHOD_TABLE) as AdapterMethod[];

/**
 * An adapter that records every call and does nothing else.
 *
 * The node-side stand-in for the real engine: boundary tests assert on
 * `calls`, and `deepCopy` is deliberately absent, because the whole point is
 * that the guest reuses its command objects.
 *
 * @param options What the adapter says about itself.
 * @param options.appliesLocal False to stand in for a replica, which skips
 *   `localCommands`. Defaults to true.
 * @returns A recording adapter.
 *
 * @example
 * ```ts
 * import { NullEngineAdapter } from 'gameable/host';
 *
 * const adapter = NullEngineAdapter();
 * applyOutput(adapter, out);
 * console.log(adapter.by('spawn').length);
 * ```
 */
export function NullEngineAdapter(options: { appliesLocal?: boolean } = {}): NullAdapter {
  const calls: AdapterCall[] = [];
  let lastTransformCount = 0;

  const adapter = {
    appliesLocal: options.appliesLocal ?? true,
    calls,
    by: (method: AdapterMethod) => calls.filter((c) => c.method === method),
    reset: () => {
      calls.length = 0;
      lastTransformCount = 0;
    },
    get lastTransformCount() {
      return lastTransformCount;
    },
  } as unknown as NullAdapter;

  for (const method of METHODS) {
    (adapter as unknown as Record<string, (...args: unknown[]) => void>)[method] = (
      ...args: unknown[]
    ): void => {
      if (method === 'applyTransforms') lastTransformCount = (args[1] as number | undefined) ?? 0;
      calls.push({ method, args });
    };
  }

  return adapter;
}
