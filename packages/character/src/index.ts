/**
 * Splat characters: bundle -> rig -> vertices -> decoders -> WGSL lift -> gaussians.
 *
 * The whole avatar — head, teeth, clothes, hair, eyes — writes into ONE
 * `AnimatedGaussianSplat` in slot ranges, so it sorts as a unit. Characters require
 * the WebGPU backend; `createCharacter` rejects with `CharacterUnsupportedError` on
 * the WebGL fallback.
 */

/**
 * Package identity marker for `gameable/character`.
 *
 * @example
 * ```ts
 * import { PACKAGE } from 'gameable/character';
 *
 * console.log(PACKAGE); // 'gameable/character'
 * ```
 */
export const PACKAGE = '@gameable/character' as const;

export { createCharacter } from './Character.js';
export type {
  BodyPose,
  Character,
  CharacterOptions,
  CreateCharacterOptions,
  MemoryReport,
} from './Character.js';

export { loadCharacterBundle } from './bundle/loadCharacterBundle.js';
export type { CharacterBundle, LoadCharacterBundleOptions } from './bundle/loadCharacterBundle.js';

export { CharacterUnsupportedError } from './errors.js';

export type { SlotRange, SplatSink, SplatSinkBuffers } from './splatSink.js';
export { SlotAllocator } from './render/slotAllocator.js';

export {
  DebugVertexLift,
  debugLiftDispatch,
  fitVertsTransform,
  writeDebugLiftParams,
  DEBUG_LIFT_PARAMS_BYTES,
  DEBUG_LIFT_WORKGROUP,
  IDENTITY_3X4,
} from './debug/DebugVertexLift.js';
export type {
  DebugLiftParams,
  DebugShading,
  DebugVertexLiftOptions,
} from './debug/DebugVertexLift.js';
export { createRigPreview } from './debug/rigPreview.js';
export type { CreateRigPreviewOptions, RigPreview } from './debug/rigPreview.js';
export { flatTint, heightTint, jointTint, packRgba, uvTint } from './debug/vertexTint.js';
export type { TintKind } from './debug/vertexTint.js';

export {
  ARKIT_TO_GNM_DEFAULT,
  createArkitToGnmMap,
  GAZE_FULL_SCALE,
} from './expression/arkitToGnmDefault.js';
export type {
  ArkitGnmTable,
  ArkitGnmTerm,
  ArkitToGnmOptions,
} from './expression/arkitToGnmDefault.js';

export { prepareLiftDevice, REQUIRED_STORAGE_BUFFERS } from './device/index.js';
export type { RendererLike } from './device/index.js';
export { attachOrtDevice, verifyOrtDevice } from './device/ortDevice.js';
export type { OrtDeviceAttachment } from './device/ortDevice.js';

export type {
  JointOverride,
  RigBackend,
  RigBackendInit,
  RigKind,
  VertsAABB,
} from './rig/RigBackend.js';
export { OrlRigBackend, orlDriveMode, ORL_HEAD_VERTS } from './rig/orl/OrlRigBackend.js';
export { GnmRigBackend, GNM_PACK_FILE } from './rig/gnm/GnmRigBackend.js';
export {
  parseAosRig,
  packAosRig,
  regionSlices,
  unpackHeadExt,
  headExtNames,
} from './rig/gnm/gnmPack.js';
export type { AosRigHeader, AosRigPack, HeadExtLayout } from './rig/gnm/gnmPack.js';
export { gnmForward, gnmPose, gazeToEyeRotations } from './rig/gnm/gnmReference.js';

export type {
  CharacterManifest,
  ExpressionKind,
  ExpressionSpace,
  RigBackendKind,
  RigManifest,
} from './assets/characterManifest.js';

export { arkitToRig } from './rig/arkit/arkitToRig.js';
export { arkitToMh, MH_LEN } from './rig/arkit/arkitToMh.js';
export { gatherFromRigNames } from './rig/arkit/rigGatherFromNames.js';
export { ARKIT_NAMES } from './rig/arkit/arkitNames.js';
export { createFittedArkitMap, type FittedArkitMap } from './expression/arkitFitted.js';
export { MH_RIG_NAMES } from './rig/arkit/rigNamesMh.js';

export { headJointOf, loadAosrigSplatBundle, releaseSharedClips } from './aosrigSplat/format.js';
export { yieldingPause } from './aosrigSplat/packed.js';
export type {
  ArkitFaceTableInfo,
  AosrigSplatDescriptor,
  AosrigSplatBundle,
  AosrigSplatLoadOptions,
  AosrigCorrectiveFiles,
} from './aosrigSplat/format.js';
export {
  createSomaPoser,
  createSomaRig,
  parseSomaClips,
  parseSomaSkeleton,
  somaAnimationClip,
} from './aosrigSplat/soma.js';
export type { SomaClip, SomaJoint, SomaPoser, SomaSkeleton } from './aosrigSplat/soma.js';
export { createAosrigSplat } from './aosrigSplat/runtime.js';
export { buildAosrigCharacter } from './aosrigSplat/host.js';
export type {
  AosrigCharacterBuild,
  AosrigHostSink,
  AosrigSinkRequest,
} from './aosrigSplat/host.js';
export { capturedLightSamples } from './aosrigSplat/capturedLight.js';
export type {
  CapturedLightOptions,
  CapturedLightSamples,
  RigSurface,
} from './aosrigSplat/capturedLight.js';
export type {
  AosrigSplatRuntime,
  AosrigCorrectiveState,
  AosrigMouthHiddenState,
} from './aosrigSplat/runtime.js';
export { BAND_CAP_M, hiddenAlpha, parseMouthHidden, plugPush } from './aosrigSplat/mouthHidden.js';
export type { MouthHidden } from './aosrigSplat/mouthHidden.js';
export {
  MAX_CORRECTIONS_PLAYED,
  armAngleDeg,
  blendWeight,
  correctivePoints,
  parseCorrectiveIndex,
} from './aosrigSplat/corrective.js';
export type { CorrectiveDrive, CorrectiveInfo } from './aosrigSplat/corrective.js';
export { MOUTH_RENDER_ORDER } from './aosrigSplat/mouthRuntime.js';
export type {
  AosrigMouth,
  AosrigMouthOptions,
  AosrigTeethFiles,
} from './aosrigSplat/mouthRuntime.js';
