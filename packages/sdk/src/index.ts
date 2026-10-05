/**
 * `gameable` — the only package game code imports.
 *
 * Everything a game needs on the guest side of the wasm boundary:
 * `defineGame`, the bitecs re-exports and built-in SoA components, prefabs,
 * and the `input` / `physics` / `camera` / `hud` / `audio` / `character`
 * facades that marshal across the boundary without allocating.
 *
 * @example
 * ```ts
 * import { defineGame, prefab, input, physics, hud } from 'gameable';
 *
 * const Player = prefab({
 *   body: { shape: 'capsule', dims: [0.3, 0.9], kind: 'character' },
 * });
 *
 * export default defineGame({
 *   assets: ['arena'],
 *   player: { prefab: Player, spawn: [0, 1, 0], camera: 'firstPerson' },
 *   systems: [
 *     (ctx) => {
 *       const move = ctx.input.axis2('A', 'D', 'S', 'W');
 *       ctx.physics.moveCharacter(ctx.player, move.x * 4, 0, move.y * 4);
 *       ctx.hud.set({ frame: ctx.frame });
 *     },
 *   ],
 * });
 * ```
 */

/**
 * Package identity marker.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable';
 *
 * console.log(PACKAGE); // 'gameable'
 * ```
 */
export const PACKAGE = '@gameable/sdk' as const;

export { defineGame } from './defineGame';

export { featuresOf } from './features';
export type { FeatureOptions, FeatureSpec, MultiplayerOptions } from './features';
export type {
  GameContext,
  GameDefinition,
  GameSpec,
  PlayerSpawn,
  PlayerSpec,
  SpawnSpec,
  System,
  WorldSpec,
} from './defineGame';

export { createGuest, maxEntities, activeRuntime } from './runtime';
export type { Guest } from './runtime';

export { LAYER_KEYS, prefab, prefabRegistry, resetPrefabRegistry, spawn, despawn } from './prefab';
export type { BodySpec, PrefabDef, PrefabSpec } from './prefab';

export {
  BODY_KINDS,
  BUILTIN_COMPONENTS,
  BUILTIN_COMPONENT_NAMES,
  Character,
  DEFAULT_MAX_ENTITIES,
  Enemy,
  Health,
  Pickup,
  Player,
  Renderable,
  RigidBody,
  SHAPE_KINDS,
  Transform,
  Velocity,
  addComponent,
  addEntity,
  configureEcs,
  createWorld,
  getMaxEntities,
  hasComponent,
  query,
  removeComponent,
  removeEntity,
  resetBuiltinStores,
  And,
  Not,
  Or,
} from './ecs';
export type {
  CharacterStore,
  HealthStore,
  RenderableStore,
  RigidBodyStore,
  TransformStore,
  VelocityStore,
} from './ecs';

export { input, MOUSE_BUTTONS } from './input';
export type { Axis2 } from './input';
export {
  AUTHORITY_SENDER,
  DEFAULT_MAX_PLAYERS,
  DEFAULT_ROOM_SEATS,
  defineMessage,
  hasKeys,
  isRecord,
  MessageDef,
  roomSeats,
  roomSendHz,
} from './net';
export type {
  MessageCheck,
  MessageOptions,
  NetFacade,
  NetMessage,
  NetRole,
  NetStats,
  PlayerHandle,
  Players,
  SendOptions,
  SidedSystem,
} from './net';
export { applyTransfer } from './data';
export type { DataFacade, TransferDoc } from './data';
export { physics } from './physics';
export { camera, quatFromYawPitch } from './camera';
export type { FirstPersonOptions, FollowOptions } from './camera';
export { hud } from './hud';
export { audio } from './audio';
export type { PlayOptions } from './audio';
export { character, EXPRESSION_DIMS } from './character';
export { assetId, describeAsset, loadAsset } from './assets';

export { createRng } from './rng';
export type { Rng, RngState } from './rng';

export {
  BODY_STRIDE,
  BodyIndex,
  TRANSFORM_ALL,
  TRANSFORM_FLAGS,
  TRANSFORM_STRIDE,
  TransformPacker,
  markMoved,
} from './packing';
export { CommandBuffer, TAG_ORDINAL, commandPoolSize } from './commands';

export { SNAPSHOT_VERSION, readSnapshot, writeSnapshot } from './save';

export {
  KEY_BITS,
  KEY_COUNT,
  KEY_NAMES,
  KEY_WORDS,
  keyIndex,
  keyIndex2,
  readKeyBit,
  writeKeyBit,
} from './keycodes';
export type { KeyName } from './keycodes';

export { setLogSink, setRandomSource, utf8Decode, utf8Encode, IS_COMPONENT_GUEST } from './prelude';
export type { LogSink } from './prelude';

export { getActiveRuntime, requireRuntime, setActiveRuntime } from './state';
export type { HudState, LookState, MutableGamepad, RuntimeState } from './state';

export type {
  AddBodyCmd,
  AnimEventData,
  ApplyImpulseCmd,
  AssetDesc,
  AssetId,
  AssetKind,
  AssetLoadedEvent,
  AudioBus,
  BodyFlags,
  BodyId,
  BodyKind,
  CameraMode,
  CameraState,
  CharacterReadyEvent,
  CollisionLayers,
  Command,
  CommandTag,
  ConversationCmd,
  ConversationEvent,
  Contact,
  ContactPhase,
  Entity,
  ErrorCode,
  ExchangeCmd,
  ExchangeResultEvent,
  ExpressionSpace,
  FrameInput,
  FrameOutput,
  GameConfig,
  GameDataEvent,
  GameError,
  GameEvent,
  GamepadState,
  GuestExports,
  HostApi,
  HostFrameInput,
  HostGameConfig,
  InputMods,
  InputState,
  KeyState,
  LoadAssetCmd,
  LogLevel,
  LookAtCmd,
  MaterialValue,
  MouseState,
  MoveCharacterCmd,
  NetCommand,
  NetEvent,
  NetMessageEvent,
  OverlapHit,
  PlayerInput,
  PlayerJoinedEvent,
  PlayerLeftEvent,
  PlaySoundCmd,
  ProjectionKind,
  Quat,
  QueryFilter,
  RayHit,
  RayQuery,
  Rgba,
  SaveGameDataCmd,
  SavePlayerDataCmd,
  SayCmd,
  SendCmd,
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
  SetPlayerCameraCmd,
  SetPlayerEntityCmd,
  SetPlayerHudCmd,
  Shape,
  ShapeKind,
  SoundEndedEvent,
  SoundId,
  SpawnCharacterCmd,
  SpawnCmd,
  StopSoundCmd,
  Vec3,
} from './types';

/**
 * Guest interview controls.
 *
 * @example
 * ```ts
 * import { conversation } from "gameable";
 * conversation.command(npc, "start", "steward");
 * ```
 */
export { conversation } from './conversation';

/**
 * Camera-relative acceleration, idle turning and contact-driven jump phases.
 *
 * @example
 * ```ts
 * import { createThirdPersonController } from 'gameable';
 * const controller = createThirdPersonController();
 * console.log(controller.state.facing); // Math.PI: +Z rig faces into the level
 * ```
 */
export { createThirdPersonController, type ThirdPersonClips } from './thirdPerson';
